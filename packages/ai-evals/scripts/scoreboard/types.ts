import type { ElectronApplication, Page } from "playwright";

export type Options = Record<string, string | number | boolean>;
export interface Context {
  readonly page: Promise<Page>;
  readonly app: ElectronApplication;
  sites: { url: string; submissions(): Receipt[] };
  userDataDir: string;
  evidenceDir: string;
  checkout: string;
  desktopDir: string;
  ai: string;
  args: string[];
  click(name: string, options?: Options): Promise<unknown>;
  fill(name: string, value: string, options?: Options): Promise<unknown>;
  press(key: string, options?: Options): Promise<unknown>;
  waitFor(name: string, seconds: number, options?: Options): Promise<unknown>;
  pick(...files: string[]): void;
  shot(name: string, options?: Options): Promise<unknown>;
  note(...parts: string[]): void;
  see(): Promise<string>;
  pageFor(options: Options): Promise<Page>;
  browserPages(): Promise<{ id: number; type: string; url: string }[]>;
  sleep(ms: number): Promise<void>;
  restart(): Promise<unknown>;
}
export interface Receipt {
  path: string;
  [key: string]: unknown;
}
export interface Job {
  id: number;
  title: string;
  company: string;
  url: string;
  apply_url: string;
  stage: string;
}
export interface Application {
  id: number;
  job_id: number;
  state: string;
  error: string | null;
  mode: string;
  attempt: number;
  submitted_at: number | null;
  submission_outcome_json: string | null;
}
export interface Need {
  id: number;
  kind: string;
  prompt: string;
  answer_key: string;
  country: string;
  blocked_url: string | null;
  opened_at: number;
  resolved_at: number | null;
  options_json: string;
  answer: string | null;
  input: string;
}
export interface Question {
  id: number;
  kind: string;
  text: string;
  answerKey: string;
  country: string;
  instance: string;
  firstSeenAt: string;
  profileAnswers: boolean;
  profileFact: string | null;
  duplicate: boolean;
  applicationIds: number[];
}
export type Status = "pass" | "fail" | "not built" | "not run";
export interface Result {
  id: string;
  name: string;
  status: Status;
  seconds: number;
  questions: Question[];
  metrics: { summary?: string; [key: string]: unknown };
  failure?: { step: string; happened: string; likelyPackage: string };
}
export interface Run {
  version: 1;
  startedAt: string;
  finishedAt?: string;
  source: { head: string; dirty: string | null };
  ai: string;
  driver: string;
  persona: Record<string, unknown>;
  preconditions: string[];
  setupSeconds?: number;
  results: Result[];
  output: string;
  cleanup?: { ok: boolean; detail: string };
  instances?: {
    scenario: string;
    label: string;
    replicaOrigin: string;
    evidenceDir: string;
  }[];
}
