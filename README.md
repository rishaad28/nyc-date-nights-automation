# NYC Date Nights automation

This small public repository runs the scheduled NYC Date Nights Instagram Reel sync and creates short, silent in-app video previews when Instagram does not provide playable media through its API.

It contains no application source code, venue database, user data, passwords, access tokens, or browser cookies. Production credentials are stored only as encrypted GitHub Actions secrets.

The preview worker downloads only the opening seconds required for the app, removes audio, normalizes the clip, uploads the result to the private production media endpoint, and deletes its temporary files when the job finishes.
