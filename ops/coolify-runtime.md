# Coolify runtime transition

The application container moves to Coolify using its existing image, runtime variables, memory limit, read-only CA certificate and Docker network. Existing Redis, REST adapter, TLS sidecar, domains and tunnel stay unchanged.

Keep the current GitHub runner as the only build trigger. After image build, delegate container deployment to Coolify rather than running legacy Compose up. Keep the single daily monitoring cron and change only its Docker exec target to the managed container name. Do not add a second scheduler or invoke product-writing endpoints as tests.

Archive the current image outside Docker storage, verify its checksum, and retain private env/compose/container/cron snapshots before cutover. Verify Redis connectivity and unauthenticated public routing without initiating scans, product changes or emails.

Rollback redeploys the archived image/configuration, restores the original network alias and cron target, and retains the existing Redis data. It does not restore or modify external shop data.
