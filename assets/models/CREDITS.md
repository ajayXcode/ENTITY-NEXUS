# 3D assets

## Soldier.glb
Mixamo "Vanguard by T. Choonyung", distributed with three.js
(examples/models/gltf/Soldier.glb, three.js is MIT licensed).

Mixamo assets are royalty-free for unlimited commercial and non-commercial
use, including shipping inside a finished game. The restriction is on
repackaging the raw character/animation files AS the product (asset packs,
engine templates, stock sites) - which is not what this project does.

Clips shipped with the model: Idle, Walk, Run, TPose.
Every combat animation in this project (the three attacks, block, hit
reaction and death) is authored by us in js/render3d.js as direct bone
rotations on the Mixamo skeleton, not imported.

## Katana
Built procedurally in js/render3d.js from primitives. No source asset.

## Arena, crowd, lighting, VFX
All generated in code in js/render3d.js. No source assets.
