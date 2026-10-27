import { z } from "zod";
import { speedLevelValues } from "./speed";

export const SpeedLevelSchema = z.enum(speedLevelValues);
