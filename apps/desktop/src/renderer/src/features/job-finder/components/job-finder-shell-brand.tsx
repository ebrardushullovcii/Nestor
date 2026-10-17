import type { CSSProperties } from "react";
import type { SuiteModule } from "@nestor/contracts";

import { NestorWordmark } from "@renderer/components/brand/nestor-wordmark";
import { ModuleSwitch } from "@renderer/components/module-switch";
import { cn } from "@renderer/lib/cn";

/**
 * One brand lockup for both workspace opening and the interactive shell.
 * macOS traffic lights occupy the leading title-bar area; callers keep that
 * reservation on the containing brand row so the centered module switcher is
 * never shifted with the wordmark.
 */
export interface JobFinderShellBrandModuleSwitch {
  activeModule?: SuiteModule;
  onSelectModule: (moduleName: SuiteModule) => void;
  style?: CSSProperties;
}

export function JobFinderShellBrand(props: {
  className?: string;
  /**
   * When given, the subtitle under the wordmark is the module switcher: the
   * active module's name in small caps with a chevron, which opens the menu
   * naming both modules. Without it (static opening frames), the subtitle is
   * the plain module name in the same place and size, so nothing jumps when
   * the interactive shell takes over.
   */
  moduleSwitch?: JobFinderShellBrandModuleSwitch;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn(
        // Keep the system face's painted ascenders/descenders away from the
        // hiddenInset edge. The 56px shell row still has room for the full
        // lockup at native 125% and when the sidebar is collapsed.
        "relative z-20 flex h-full w-max shrink-0 flex-col justify-center gap-0.5 whitespace-nowrap py-1",
        props.className,
      )}
      data-desktop-brand-lockup
      style={props.style}
    >
      <span className="max-[639px]:hidden" data-desktop-brand-wordmark>
        <NestorWordmark className="block h-[1.05rem] w-auto text-(--headline-primary) sm:h-[1.3rem]" />
      </span>
      {/* The module name is the subtitle of the wordmark, and that subtitle is
          the module switcher: one line, always visible, in the one place a
          person expects to read which part of the product they are in. It
          sits in the brand block rather than in the sidebar or the top bar's
          middle, so it never competes with navigation or drifts with the
          utilities. */}
      {props.moduleSwitch ? (
        <div data-desktop-brand-subtitle>
          <ModuleSwitch
            activeModule={props.moduleSwitch.activeModule ?? "job-finder"}
            onSelectModule={props.moduleSwitch.onSelectModule}
            variant="caption"
            {...(props.moduleSwitch.style
              ? { style: props.moduleSwitch.style }
              : {})}
          />
        </div>
      ) : (
        <span
          className="whitespace-nowrap text-[0.72rem] font-semibold uppercase leading-none tracking-(--tracking-caps) text-foreground sm:text-[0.78rem]"
          data-desktop-brand-subtitle
        >
          Job Finder
        </span>
      )}
    </div>
  );
}
