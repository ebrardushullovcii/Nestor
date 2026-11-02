import type { CSSProperties } from "react";
import type { SuiteModule } from "@nestor/contracts";

import { NestorWordmark } from "@renderer/components/brand/nestor-wordmark";
import { ModuleSwitch } from "@renderer/components/module-switch";
import { cn } from "@renderer/lib/cn";

/**
 * One brand lockup for both workspace opening and the interactive shell: the
 * Nestor wordmark, a hairline divider and the module name with a chevron, on
 * one line. In the interactive shell the whole lockup is the module switch,
 * so it reads as one control with one hover state. macOS traffic lights
 * occupy the leading title-bar area; callers keep that reservation on the
 * containing brand row.
 */
export interface JobFinderShellBrandModuleSwitch {
  activeModule?: SuiteModule;
  onSelectModule: (moduleName: SuiteModule) => void;
  style?: CSSProperties;
}

const BRAND_WORDMARK = (
  <span
    className="inline-flex shrink-0 items-center gap-2 pr-1"
    data-desktop-brand-wordmark
  >
    <NestorWordmark className="block h-3.5 w-auto text-(--headline-primary)" />
    <span aria-hidden="true" className="h-4 w-px bg-(--surface-panel-border)" />
  </span>
);

export function JobFinderShellBrand(props: {
  className?: string;
  /**
   * When given, the lockup is the module switcher: pressing it opens the
   * menu naming both modules. Without it (static opening frames), the same
   * lockup renders inert in the same place and size, so nothing jumps when
   * the interactive shell takes over.
   */
  moduleSwitch?: JobFinderShellBrandModuleSwitch;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn(
        "relative z-20 flex h-full w-max shrink-0 items-center whitespace-nowrap",
        props.className,
      )}
      data-desktop-brand-lockup
      style={props.style}
    >
      {props.moduleSwitch ? (
        <div data-desktop-brand-subtitle>
          <ModuleSwitch
            activeModule={props.moduleSwitch.activeModule ?? "job-finder"}
            leading={BRAND_WORDMARK}
            onSelectModule={props.moduleSwitch.onSelectModule}
            variant="caption"
            {...(props.moduleSwitch.style
              ? { style: props.moduleSwitch.style }
              : {})}
          />
        </div>
      ) : (
        <span
          className="inline-flex h-8 items-center gap-1 text-(length:--text-small) font-medium leading-none text-foreground"
          data-desktop-brand-subtitle
        >
          {BRAND_WORDMARK}
          Job Finder
        </span>
      )}
    </div>
  );
}
