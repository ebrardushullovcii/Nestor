import { z } from "zod";
import {
  JOB_FINDER_SETTINGS_SECTION_IDS,
  RESUME_VIEW_MODES,
} from "./job-finder-navigation";

export const JobFinderSettingsSectionSchema = z.enum(
  JOB_FINDER_SETTINGS_SECTION_IDS,
);
export const ResumeViewModeSchema = z.enum(RESUME_VIEW_MODES);
