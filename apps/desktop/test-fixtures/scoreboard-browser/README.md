# Synthetic browser import

`profile.ts` creates a private Chrome-shaped macOS profile outside the checkout:
three AES encrypted cookies on three hosts, two filtered cookies (expired and
partitioned), one unsupported encryption value, one corrupt value, and two saved
logins. One cookie is a session freshly issued by the run's Workday replica.

The scoreboard redirects profile discovery to this fixture and supplies its
synthetic Safe Storage key inside the isolated main process. It does not read or
change a real Chrome profile or Keychain. This checks the production Chrome
reader, AES decryption, filtering, import screen, encrypted Nestor vault and
session/login reuse. It does **not** check macOS Keychain consent or extraction
from a real Chrome installation. Saved-password sign-in separately uses the
normal CSV picker. All accounts and keys are invented.
