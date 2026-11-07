export function withVerificationPrivacy<T>(work: () => T): T;
export function markVerificationPrivate(): void;
export function verificationIsPrivate(): boolean;
export function rememberVerificationSecret(value: string): void;
export function redactVerificationText(text: string): string;
export function redactVerificationData<T>(value: T): T;
