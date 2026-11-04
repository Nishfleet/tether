# verify skill

`SKILL.md` drives Tether through its in-process rig. `features/` is the feature map: one file per feature a user reaches by text.

## Keep the map honest

Run `/maintain-verification-skill` (pstack) after a change adds, removes or renames a tool or a feature. It reads the source for each feature, drives every feature once, and opens at most one PR that corrects the map. Add a feature file in the same PR that adds the feature.

## Switch it off

Delete `.claude/skills/verify/`. Nothing else depends on it.
