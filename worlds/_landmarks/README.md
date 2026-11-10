# Landmark registry (D-051)

One file per landmark. Regions list landmarks by id under `objects.landmarks`
(see `pipeline/src/pixelworld_pipeline/landmarks.py` for every field).

- **Names are references only.** Depictions never draw names, logos or
  trademarked designs; the `generic` depiction is required and is the default
  (`objects.landmarkDepiction` picks another variant where one exists).
- **Heights** are real metres unless a comment says the value is depicted.
