# Security policy

## Credential handling

The Connector starts the official Codex app-server and asks it to open the official browser authorization flow. OAuth tokens stay in the app-server's own storage and refresh lifecycle. The Connector never accepts a token from the browser, never reads the app-server credential file, and never serializes a token through Harness, logs, tests, screenshots, or package artifacts.

Harness credentials contain only an ambient connection marker. Removing that marker disconnects DSH without deleting or copying the official account credential.

## Generated files

Each request receives a fresh temporary workspace. A generated result is accepted only when its declared and canonical path remain inside that workspace, the source is a non-symlink regular file, an `O_NOFOLLOW` handle still names the same inode, bytes fit Harness limits, and magic bytes identify an allowed raster format. The temporary workspace is removed after the stream settles.

## Reporting

Report suspected credential exposure, path escape, unsafe executable resolution, or authorization-origin bypass privately to the maintainers. Do not include live credentials or generated private content in a report.
