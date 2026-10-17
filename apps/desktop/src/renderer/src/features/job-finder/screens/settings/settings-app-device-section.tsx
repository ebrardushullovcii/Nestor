import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  collapsesSideMenuWithAssistant,
  type AppearanceTheme,
  type JobFinderSettings,
  type UpdateWorkspaceBehaviorInput,
} from "@nestor/contracts";
import { ToggleField } from "../../components/toggle-field";
import {
  applyAppearancePreference,
  getSystemPrefersDark,
} from "@renderer/lib/theme";
import { useRegisterSettingsDirtySection } from "./settings-dirty-sections";
import { SettingsSectionSaveControl } from "./settings-section-save-control";
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

interface SettingsAppDeviceSectionProps {
  /** Reports staged theme edits so a stale shell save retry is retired. */
  onSettingsDraftEdited?: () => void;
  onUpdateAppearanceTheme: (
    theme: AppearanceTheme,
  ) => Promise<boolean | void> | void;
  /** Saves the side menu choice; the same path as Browser & saved jobs. */
  onUpdateWorkspaceBehavior?: (
    input: UpdateWorkspaceBehaviorInput,
  ) => Promise<boolean | void> | void;
  settings: JobFinderSettings;
}

export function SettingsAppDeviceSection({
  onSettingsDraftEdited,
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

  const updateSelectedTheme = (theme: AppearanceTheme) => {
    if (isSavePending) {
      return;
    }
    setSelectedTheme(theme);
    applyAppearancePreference(theme, getSystemPrefersDark());
    resetSectionSave();
    onSettingsDraftEdited?.();
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
  const saveAppearanceTheme = () => {
    if (!hasUnsavedChanges || isSavePending) {
      return;
    }
    void runSectionSave({
      execute: async () => {
        try {
          const saved = await onUpdateAppearanceTheme(selectedTheme);
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
      savedMessage: "Appearance saved. Job Finder now uses this theme.",
    });
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
    <section className="surface-panel-shell grid min-w-0 content-start gap-3 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 max-w-[72ch] flex-1 gap-1">
          <h3
            className="min-w-0 font-semibold text-(--text-headline)"
            id={appearanceHeadingId}
          >
            Appearance
          </h3>
          <p className="text-(length:--text-description) leading-5 text-foreground-soft">
            Use system if you want Job Finder to follow the OS, or pin a theme
            when you want a stable visual working environment.
          </p>
        </div>
        <SettingsSectionSaveControl
          hasUnsavedChanges={hasUnsavedChanges}
          onSave={saveAppearanceTheme}
          saveState={saveState}
          subject="appearance"
        />
      </div>

      {/* One segmented control instead of three separate radio-shaped
          buttons. Each segment stays an ordinary button with `aria-pressed`,
          so assistive technology and UI automation both address it by its
          visible name and pressed state. Nothing is layered over this row:
          the sticky Settings subnav keeps its own flow space above the first
          section, and every section clears it with `scroll-mt`. */}
      <div
        aria-labelledby={appearanceHeadingId}
        className="relative flex w-fit min-w-0 max-w-full flex-wrap items-center gap-0.5 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/45 p-0.5"
        data-settings-appearance-theme-group
        role="group"
      >
        {appearanceThemeOptions.map((option) => {
          const isSelected = selectedTheme === option.value;
          return (
            <button
              aria-pressed={isSelected}
              className={`inline-flex min-h-9 items-center justify-center rounded-(--radius-small) px-3.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60 ${isSelected ? "bg-primary/10 text-foreground ring-1 ring-primary/70" : "text-foreground-soft hover:bg-secondary hover:text-foreground"}`}
              disabled={isSavePending}
              key={option.value}
              onClick={() => updateSelectedTheme(option.value)}
              type="button"
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <div className="grid gap-1">
        <h4 className="font-medium">Text size</h4>
        <p className="text-sm text-foreground-soft">
          Use View → Zoom In to make text bigger, Zoom Out to make it smaller,
          or Actual Size to reset it. Your chosen size is remembered when you
          reopen Nestor.
        </p>
      </div>
      {onUpdateWorkspaceBehavior ? (
        <ToggleField
          checked={draftCollapseSideMenu}
          className="max-w-xl"
          description="Fold the side menu to icons when the assistant opens beside the page, and open it again when the assistant closes."
          hint={
            sideMenuSaveFailed
              ? "That change was not saved. Try the switch again."
              : "Saved as soon as you flip it. Folding or opening the menu yourself always wins."
          }
          label="Collapse the side menu while the assistant is open"
          onCheckedChange={updateCollapseSideMenu}
        />
      ) : null}
    </section>
  );
}
