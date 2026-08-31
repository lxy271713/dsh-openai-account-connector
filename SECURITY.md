# Security policy

## Credential handling

The Connector starts the official Codex app-server and asks it to open the official browser authorization flow. OAuth tokens stay in the app-server's own storage and refresh lifecycle. The Connector never accepts a token from the browser, never reads the app-server credential file, and never serializes a token through Harness, logs, tests, screenshots, or package artifacts.

Harness credentials contain only an ambient connection marker. Removing that marker disconnects DSH without deleting or copying the official account credential.

## Generated files

Each request receives a fresh temporary execution workspace, which is removed after the stream settles. The official app-server stores generated images under the `generated_images` directory inside the absolute runtime data root returned by its initialize handshake. A generated result is accepted only when its declared and canonical path remain inside that trusted directory, the directory and source are not symlinks, an `O_NOFOLLOW` handle still names the same single-link regular-file inode, bytes fit Harness limits, and magic bytes identify an allowed raster format. Accepted bytes are copied into Harness attachments; the Connector does not delete the official runtime's generated file.

## Reporting

Report suspected credential exposure, path escape, unsafe executable resolution, or authorization-origin bypass privately to the maintainers. Do not include live credentials or generated private content in a report.
