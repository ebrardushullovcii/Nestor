import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  collapsesSideMenuWithAssistant,
  type AppearanceTheme,
  type JobFinderSettings,
  type UpdateWorkspaceBehaviorInput,
} from "@nestor/contracts";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import { ToggleField } from "../../components/toggle-field";
import {
  applyAppearancePreference,
  getSystemPrefersDark,
} from "@renderer/lib/theme";
import { useRegisterSettingsDirtySection } from "./settings-dirty-sections";
import { SettingsSectionSaveControl } from "./settings-section-save-control";
import { SettingsRow } from "./settings-row";
import { SettingsSpeedControl } from "./settings-speed-control";
import {
  hasOutstandingSectionChanges,
  useSettingsSectionSave,
} from "./settings-section-save";

const appearanceThemeOptions: ReadonlyArray<{
  label: string;
  value: AppearanceTheme;
}> = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

function zoomModifier(): string {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform)
    ? "⌘"
    : "Ctrl";
}

function zoomKeysSentence(): string {
  const mod = zoomModifier();
  return `${mod} + and ${mod} − make text bigger or smaller; ${mod} 0 sets it back.`;
}

/** The three zoom combos as keycaps, for the row's control side. */
function zoomKeycaps(): string[] {
  const mod = zoomModifier();
  return [`${mod} +`, `${mod} −`, `${mod} 0`];
}

interface SettingsAppDeviceSectionProps {
  onUpdateAppearanceTheme: (
    theme: AppearanceTheme,
  ) => Promise<boolean | void> | void;
  /** Saves the side menu choice independently of the theme. */
  onUpdateWorkspaceBehavior?: (
    input: UpdateWorkspaceBehaviorInput,
  ) => Promise<boolean | void> | void;
  settings: JobFinderSettings;
}

export function SettingsAppDeviceSection({
  onUpdateAppearanceTheme,
  onUpdateWorkspaceBehavior,
  settings,
}: SettingsAppDeviceSectionProps) {
  const appearanceHeadingId = useId();
  const [selectedTheme, setSelectedTheme] = useState<AppearanceTheme>(
    settings.appearanceTheme,
  );
  const { resetSectionSave, runSectionSave, saveState } =
    useSettingsSectionSave();

  const savedCollapseSideMenu = collapsesSideMenuWithAssistant(settings);
  const [draftCollapseSideMenu, setDraftCollapseSideMenu] = useState(
    savedCollapseSideMenu,
  );

  useEffect(() => {
    setSelectedTheme(settings.appearanceTheme);
  }, [settings.appearanceTheme]);

  useEffect(() => {
    setDraftCollapseSideMenu(savedCollapseSideMenu);
  }, [savedCollapseSideMenu]);

  const isSavePending = saveState.status === "saving";
  const themeChanged = selectedTheme !== settings.appearanceTheme;
  const hasUnsavedChanges = themeChanged;
  const [sideMenuSaveFailed, setSideMenuSaveFailed] = useState(false);

  // Picking a theme used to change nothing on screen until the user found and
  // pressed Save and an IPC round trip finished, so the interval between the
  // click and any evidence of it read as a dead control. The preview is
  // applied on click and Save stays the persistence commit.
  const savedThemeRef = useRef(settings.appearanceTheme);
  savedThemeRef.current = settings.appearanceTheme;
  const selectedThemeRef = useRef(selectedTheme);
  selectedThemeRef.current = selectedTheme;

  const revertThemePreview = useCallback(() => {
    applyAppearancePreference(savedThemeRef.current, getSystemPrefersDark());
  }, []);

  // Leaving Settings without saving must not leave the app wearing a theme
  // that was never persisted.
  useEffect(
    () => () => {
      if (selectedThemeRef.current !== savedThemeRef.current) {
        applyAppearancePreference(
          savedThemeRef.current,
          getSystemPrefersDark(),
        );
      }
    },
    [],
  );

  const saveTheme = (theme: AppearanceTheme) => {
    void runSectionSave({
      execute: async () => {
        try {
          const saved = await onUpdateAppearanceTheme(theme);
          if (saved === false) {
            // The persisted theme is still the old one; showing the new one
            // would be the app lying about what it stored.
            revertThemePreview();
          }
          return saved;
        } catch (error) {
          revertThemePreview();
          throw error;
        }
      },
      failedMessage:
        "Appearance was not saved. Retry before leaving this page.",
      savedMessage: "Appearance saved.",
    });
  };
  // A theme is one click: it shows and saves at once, like the switch below.
  // Picking one used to wait for a separate Save appearance press.
  const updateSelectedTheme = (theme: AppearanceTheme) => {
    if (isSavePending) {
      return;
    }
    setSelectedTheme(theme);
    applyAppearancePreference(theme, getSystemPrefersDark());
    resetSectionSave();
    if (theme !== settings.appearanceTheme) saveTheme(theme);
  };
  // A switch acts when flipped: this layout choice saves at once instead of
  // waiting for Save appearance, and goes back if the save fails.
  const updateCollapseSideMenu = (checked: boolean) => {
    setDraftCollapseSideMenu(checked);
    setSideMenuSaveFailed(false);
    const revert = () => {
      setDraftCollapseSideMenu(!checked);
      setSideMenuSaveFailed(true);
    };
    try {
      void Promise.resolve(
        onUpdateWorkspaceBehavior?.({
          collapseSideMenuWithAssistant: checked,
        }),
      ).then((saved) => {
        if (saved === false) revert();
      }, revert);
    } catch {
      revert();
    }
  };
  // Retry after a failed save.
  const saveAppearanceTheme = () => {
    if (!hasUnsavedChanges || isSavePending) {
      return;
    }
    saveTheme(selectedTheme);
  };

  useRegisterSettingsDirtySection({
    anchorId: "settings-app-device",
    isDirty: hasOutstandingSectionChanges(hasUnsavedChanges, saveState),
    isSaving: isSavePending,
    label: "App & device",
    onSave: saveAppearanceTheme,
    order: 0,
    saveLabel: "Save appearance",
  });

  return (
    <section className="surface-panel-shell grid min-w-0 content-start gap-4 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 max-w-[70ch] flex-1 gap-1">
          <h3
            className="min-w-0 font-semibold text-(--text-headline)"
          >
            App & device
          </h3>
          <p className="text-(length:--text-description) leading-5 text-foreground-soft">
            How Nestor looks and how much it does at once on this computer.
          </p>
        </div>
        <SettingsSectionSaveControl
          hasUnsavedChanges={hasUnsavedChanges}
          onSave={saveAppearanceTheme}
          saveState={saveState}
          subject="appearance"
        />
      </div>

      <div className="grid min-w-0">
        {/* The shared segmented control: a sunken track and a raised thumb
            with a 3:1 edge. Each segment stays an ordinary button with
            `aria-pressed`, so assistive technology and UI automation both
            address it by its visible name and pressed state. */}
        <SettingsRow
          control={
            <SegmentedControl<AppearanceTheme>
              aria-labelledby={appearanceHeadingId}
              data-settings-appearance-theme-group
              label="Appearance"
              onValueChange={updateSelectedTheme}
              options={appearanceThemeOptions.map((option) => ({
                ...option,
                disabled: isSavePending,
              }))}
              size="field"
              value={selectedTheme}
            />
          }
          description="Follow your system's light or dark mode, or pick one."
          label="Appearance"
          labelId={appearanceHeadingId}
        />
        <SettingsRow
          control={
            <span className="flex items-center gap-1 text-(length:--text-small) text-foreground-soft">
              {zoomKeycaps().map((keycap) => (
                <kbd
                  className="inline-flex min-w-7 items-center justify-center rounded-(--radius-small) border border-(--surface-panel-border) bg-(--input) px-1.5 py-0.5 text-(length:--text-tiny) font-medium text-foreground"
                  key={keycap}
                >
                  {keycap}
                </kbd>
              ))}
            </span>
          }
          description={
            // The window has no menu bar on Windows, so the keys are named
            // rather than a View menu nobody can open.
            <>{zoomKeysSentence()} Nestor keeps the size you pick.</>
          }
          label="Text size"
        />
        {onUpdateWorkspaceBehavior ? (
          <ToggleField
            checked={draftCollapseSideMenu}
            description="Fold the side menu to icons when the assistant opens beside the page, and open it again when it closes."
            {...(sideMenuSaveFailed
              ? { hint: "That change was not saved. Try the switch again." }
              : {})}
            label="Collapse the side menu while the assistant is open"
            onCheckedChange={updateCollapseSideMenu}
          />
        ) : null}
        {onUpdateWorkspaceBehavior ? (
          <SettingsSpeedControl
            onUpdateWorkspaceBehavior={onUpdateWorkspaceBehavior}
            settings={settings}
          />
        ) : null}
      </div>
    </section>
  );
}
