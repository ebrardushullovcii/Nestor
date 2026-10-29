import { useEffect, useState } from "react";
import { KeyRound, X } from "lucide-react";
import { Dialog } from "@renderer/components/ui/dialog";
import type {
  BrowserPasswordPrompt,
  DesktopBrowserBridge,
  BrowserPasswordsList,
  DesktopBrowserImportSource,
} from "@nestor/contracts";

export function BrowserPasswordOffer({
  prompt,
  bridge,
  message,
}: {
  prompt: BrowserPasswordPrompt;
  bridge: DesktopBrowserBridge;
  message: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="browser-notice" role="status">
      <KeyRound size={15} />
      <span className="browser-notice-text">
        <strong>
          {prompt.update ? "Update saved password?" : "Save password?"}
        </strong>{" "}
        {prompt.username || "Login"} · {prompt.origin}
      </span>
      <button
        type="button"
        className="browser-notice-action"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void bridge.passwords
            .save({ promptId: prompt.id })
            .then(() =>
              message(
                prompt.update
                  ? "Password updated."
                  : "Password saved on this device.",
              ),
            )
            .catch(() =>
              message(
                "This login could not be saved. Enter it on the site again.",
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        {prompt.update ? "Update" : "Save"}
      </button>
      <button
        type="button"
        aria-label="Dismiss password offer"
        onClick={() => {
          void bridge.passwords
            .dismiss({ promptId: prompt.id })
            .catch(() => undefined);
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function BrowserPasswordPanel({
  bridge,
  tabId,
  close,
}: {
  bridge: DesktopBrowserBridge;
  tabId: string | null;
  close: () => void;
}) {
  const [listed, setListed] = useState<BrowserPasswordsList | null>(null);
  const [all, setAll] = useState(false);
  const [sources, setSources] = useState<DesktopBrowserImportSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = () =>
    bridge.passwords.list(all || !tabId ? {} : { tabId }).then(setListed);
  useEffect(() => {
    let live = true;
    void bridge.passwords
      .list(all || !tabId ? {} : { tabId })
      .then((value) => {
        if (live) setListed(value);
      })
      .catch(() => {
        if (live) setMessage("Saved logins are unavailable.");
      });
    void bridge
      .listImportSources()
      .then((value) => {
        if (live) setSources(value.sources);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bridge, tabId, all]);
  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    void work()
      .catch(() =>
        setMessage(
          "This action could not finish. Open a matching login form to fill, or try importing again.",
        ),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Dialog
      open
      onClose={close}
      closeLabel="Close passwords"
      title="Saved passwords"
      description="Encrypted on this device. Fill a saved login here, or let the agent use it when Sign in is enabled. Type missing logins on the site."
    >
      <div className="mx-1 grid min-w-0 gap-3">
        {listed?.message && (
          <p className="browser-import-empty">{listed.message}</p>
        )}
        {message && (
          <p className="browser-import-result" role="status">
            {message}
          </p>
        )}
        <button
          type="button"
          className="browser-notice-action"
          onClick={() => setAll((value) => !value)}
        >
          {all ? "Show this site's logins" : "Manage all saved logins"}
        </button>
        <div className="browser-import-list">
          {listed?.credentials.map((credential) => (
            <div className="browser-password-row" key={credential.id}>
              <span className="browser-import-source-text">
                <span>{credential.username || "No username"}</span>
                <small>{credential.origin}</small>
              </span>
              {!all && tabId && (
                <button
                  type="button"
                  className="browser-notice-action"
                  disabled={busy || !listed.available}
                  onClick={() =>
                    run(async () => {
                      await bridge.passwords.autofill({
                        tabId,
                        credentialId: credential.id,
                      });
                      close();
                    })
                  }
                >
                  Fill
                </button>
              )}
              <button
                type="button"
                className="browser-notice-action"
                disabled={busy}
                aria-label={`Delete login for ${credential.username || credential.origin}`}
                onClick={() =>
                  run(async () => {
                    await bridge.passwords.delete({
                      credentialId: credential.id,
                    });
                    await refresh();
                  })
                }
              >
                Delete
              </button>
            </div>
          ))}
          {listed?.available && !listed.credentials.length && (
            <p className="browser-import-empty">
              {all
                ? "No saved logins yet."
                : "No saved logins for this site. Enter a login on the site and choose Save when offered."}
            </p>
          )}
        </div>
        <div className="browser-import-foot">
          <button
            type="button"
            className="browser-import-done"
            disabled={busy || listed?.available === false}
            onClick={() =>
              run(async () => {
                const result = await bridge.passwords.importCsv();
                setMessage(result.message);
                await refresh();
              })
            }
          >
            {busy ? "Working…" : "Import password CSV…"}
          </button>
        </div>
        <p className="browser-password-help">
          In Chrome, Edge or Firefox, open the password manager and export
          passwords to CSV. Choose that file here. Exported CSV files contain
          readable passwords; remove your export yourself after importing.
        </p>
        {sources.length > 0 && (
          <details>
            <summary>Import directly from a browser</summary>
            <p className="browser-password-help">
              Windows browser protection and Firefox may require CSV instead.
            </p>
            <div className="browser-import-list">
              {sources.map((source) => (
                <button
                  type="button"
                  className="browser-import-source"
                  key={source.id}
                  disabled={
                    busy ||
                    listed?.available === false ||
                    !source.passwordImport.supported
                  }
                  title={source.passwordImport.note ?? undefined}
                  onClick={() =>
                    run(async () => {
                      const result = await bridge.passwords.importFromBrowser({
                        sourceId: source.id,
                      });
                      setMessage(result.message);
                      await refresh();
                    })
                  }
                >
                  <span className="browser-import-source-text">
                    <span>{source.browserLabel}</span>
                    <small>{source.profileLabel}</small>
                    {!source.passwordImport.supported && (
                      <small>
                        {source.passwordImport.note ??
                          "Export passwords to CSV instead."}
                      </small>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </details>
        )}
      </div>
    </Dialog>
  );
}
