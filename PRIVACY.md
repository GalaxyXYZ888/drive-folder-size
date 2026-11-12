# Privacy policy

Drive Folder Size is a Firefox extension that shows folder sizes in Google
Drive's list view. It has no server of its own and the developer receives no
data from it.

## What it accesses

The extension signs in to your Google account with the Google Cloud OAuth
client you create yourself (see the README), and requests two scopes:

- `drive.readonly`: to read file metadata (id, type, size and parent folder)
  so it can add up folder sizes. File contents are never downloaded.
- `drive.appdata`: to keep an optional backup of its index in a hidden
  folder in your own Drive that only this client can see. It never writes to
  your actual files.

## What it stores

Everything is stored locally in Firefox's extension storage on your computer:

- Your Client ID and Client secret, and the sign-in tokens Google returns.
- An index of your Drive: file id, type, size and parent folder id. It holds
  no file names and no contents.
- Settings and sync status.

If the Drive backup is on, the same index is also saved as one file in the
hidden app folder of your own Google Drive.

## Where data goes

Only to Google, over HTTPS (`accounts.google.com`, `oauth2.googleapis.com`
and `www.googleapis.com`), to sign in and read your Drive metadata. Nothing is
sent to the developer or to any third party. There is no analytics, tracking
or advertising.

## Removing your data

- **Clear cache** on the setup page deletes the local index.
- **Disconnect Google account** signs out and revokes the token with Google.
- Uninstalling the extension deletes everything it stored locally.
- You can also revoke access at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
  and delete the hidden backup from Drive's storage settings.

## Contact

Questions or issues: open an issue at
[github.com/GalaxyXYZ888/drive-folder-size](https://github.com/GalaxyXYZ888/drive-folder-size/issues).
