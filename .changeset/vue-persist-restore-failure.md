---
'@tanstack/vue-query': patch
---

Reset `isRestoring` when the `clientPersister` promise rejects, so queries subscribe and fetch after a failed cache restore.
