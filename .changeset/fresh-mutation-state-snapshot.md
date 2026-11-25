---
'@tanstack/preact-query': patch
'@tanstack/react-query': patch
'@tanstack/solid-query': patch
---

fix(useMutationState): recompute the result as soon as the query client or the options change, instead of returning the previous result until the next mutation cache event
