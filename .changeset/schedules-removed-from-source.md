---
"@executor-js/sdk": patch
---

Deploying or activating a deployment now deletes the saved settings of schedules the
new deployment no longer declares, with their run history and any waiting approval.
Previously a removed schedule stayed listed, and stayed enabled until it next came due.
Nothing is deleted when the deployment cannot be evaluated.
