#!/usr/bin/env python3
"""
make-battle-sprites.py - turn the supplied character art into battle sprites.

WHY THIS EXISTS

The cabinet ships two sprite sheets (samuraiMack for P1, kenji for P2) and
that is all the engine has ever had. The character folders at the repo root
deliver eight poses each for two more fighters:

    Character 1/frames          the sai turtle, red bandana   (RAPHAEL, P1)
    Character 1/frames_clone    the same turtle, blue bandana  (RAPHAEL, P2)
    Character 2/frames_rival    the violet glaive knight      (MALGRAVE, P1+P2)

Those poses are 256x256 singles, not animation strips, and they are not laid
out on the engine's frame geometry. This script re-lays them out so that a
rendered frame lands EXACTLY where the base sheet would have landed:

    in-frame frame size     200 x 200   (the engine's frame, both sheets)
    feet line               y = 122 (P1) / y = 127 (P2)
    body centre x           x = 94.5 (P1) / x = 102.5 (P2)
    character height        53 px (P1) / 54 px (P2)

so the Fighter's existing offset (215,157)/(215,167) still applies untouched.
Only the draw SCALE changes, by 1/R, because we emit the frame at R times
the resolution. R=2 doubles it: the frame becomes 400x400 and the scale goes
from 2.5 to 1.25, so the on-screen size is identical but sampled from twice
as many source pixels.

WHY IT MATTERS THAT THE GEOMETRY IS IDENTICAL

js/classes.js and js/game.js read framesMax / framesHold / frameFrom /
frameTo off the sprite objects, and those numbers decide when attacks land
and when a fighter is considered dead. Nothing in this script touches them:
a skin is a separate set of Image objects that only draw() looks at. The
simulation is byte-for-byte the fight it was before.

The engine's animations, and which source pose each one uses:

    RAPHAEL  idle->idle  run->run  attack1->attack  attack2->heavy
             takeHit->hurt  death->ko  jump->dodge  fall->attack
    MALGRAVE idle->heavy  run->run  attack1->attack  attack2->idle
             takeHit->hurt  death->dodge  jump->ko  fall->attack

every pose wired by hand, with the reason in the table below.

RUN

    python scripts/make-battle-sprites.py

Requires Python + Pillow. It is an asset tool, not part of serving the site:
the PNGs it writes are what the browser loads, so the site stays dependency
free and keeps its no-build-step promise.
"""

import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Resolution multiplier. 1 would match the base sheet exactly (and upscale
# 53px of character to 130px on screen - soft). 2 emits a 400x400 frame so
# the draw is a downscale instead of an upscale, at a quarter of the file
# weight of R=4.
R = 2

# Measured off assets/img/samuraiMack/*.png and assets/img/kenji/*.png with
# Pillow - see the bbox dump in the README. Not eyeballed.
BASE = {
    'p1': {'feet': 122, 'cx': 94.5,  'height': 53, 'offset': (215, 157)},
    'p2': {'feet': 127, 'cx': 102.5, 'height': 54, 'offset': (215, 167)},
}

# The engine's animation names, in the order playMove/switchSprite use them.
ANIMS = ['idle', 'run', 'jump', 'fall', 'attack1', 'attack2', 'takeHit', 'death']

# champion id -> { side -> (source folder, mirror?) }
#   Every supplied pose set is drawn facing RIGHT, which is P1's direction.
#   P2 always gets the mirrored copy, so nobody is ever drawn facing away
#   from their opponent.
SOURCES = {
    'raphael': {
        'p1': ('Character 1/frames', False),
        'p2': ('Character 1/frames_clone', True),
    },
    'malgrave': {
        'p1': ('Character 2/frames_rival', False),
        'p2': ('Character 2/frames_rival', True),
    },
}

# champion id -> { engine animation -> source pose filename }
#   The supplied pose names are a superset of what the engine animates and
#   do not line up one-to-one, so each mapping is a judgement call:
#
#   raphael.attack2 = heavy   the wide red arc is the big swing
#   raphael.jump    = dodge   the crouch is the only pose off its feet
#   raphael.fall    = attack  the lunge reads as coming down onto someone
#   raphael.death   = ko      the only pose on the floor
#   raphael.special            unused - a planted aura burst is not a state
#                              the engine has
#   malgrave.idle   = heavy   the standing guard, glaive held
#   malgrave.attack2= idle    the overhead arc IS the heavy swing
#   malgrave.death  = dodge   the only pose on the floor
#   malgrave.jump   = ko      the tucked crouch
#   malgrave.fall   = attack  the extended stride
#   malgrave.takeHit= hurt    the violet flare
#
#   Both sets use all eight engine animations. Between the two champions the
#   only supplied pose left unused is raphael's 'special'.
POSE_MAP = {
    'raphael': {
        'idle': 'idle',
        'run': 'run',
        'attack1': 'attack',
        'attack2': 'heavy',
        'takeHit': 'hurt',
        'death': 'ko',
        'jump': 'dodge',
        'fall': 'attack',
    },
    'malgrave': {
        'idle': 'heavy',
        'run': 'run',
        'attack1': 'attack',
        'attack2': 'idle',
        'takeHit': 'hurt',
        'death': 'dodge',
        'jump': 'ko',
        'fall': 'attack',
    },
}


def load_pose(path, mirror):
    im = Image.open(path).convert('RGBA')
    if mirror:
        # About the image centre, so the character does not slide sideways.
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    return im


def bbox(im):
    return im.getbbox()   # (x0, y0, x1, y1), x1/y1 exclusive


def feet_y(im):
    """Lowest opaque pixel in the central 50% of the body's own x-range.

    Taking the full bbox bottom would put an aura's glow - which spreads
    well below the boots on the 'special' pose - on the ground, lifting the
    whole fighter into the air. The central band is boots on every pose we
    have, and body on the ones that are lying down.
    """
    bb = bbox(im)
    if not bb:
        return im.height
    x0, y0, x1, y1 = bb
    span = x1 - x0
    band = im.crop((int(x0 + span * 0.25), 0, int(x0 + span * 0.75), im.height))
    bbb = band.getbbox()
    return y1 if not bbb else bbb[3]


def build(champ, side):
    src_dir, mirror = SOURCES[champ][side]
    pose_map = POSE_MAP[champ]
    geo = BASE[side]
    frame = 200 * R
    out_dir = os.path.join(ROOT, 'assets', 'img', 'champ', champ, side)
    os.makedirs(out_dir, exist_ok=True)

    # The reference pose fixes the scale AND the horizontal anchor, so the
    # character does not grow, shrink or slide between states - only the
    # pose itself changes.
    ref = load_pose(os.path.join(ROOT, src_dir, pose_map['idle'] + '.png'), mirror)
    rb = bbox(ref)
    ref_h = rb[3] - rb[1]
    ref_cx = (rb[0] + rb[2]) / 2.0

    # Source pixels -> base-frame pixels.
    k = (geo['height'] * R) / float(ref_h)
    written = []

    for anim in ANIMS:
        pose = pose_map[anim]
        im = ref if pose == pose_map['idle'] else load_pose(
            os.path.join(ROOT, src_dir, pose + '.png'), mirror)

        w = max(1, int(round(im.width * k)))
        h = max(1, int(round(im.height * k)))
        small = im.resize((w, h), Image.LANCZOS)

        canvas = Image.new('RGBA', (frame, frame), (0, 0, 0, 0))
        # Body centre on the reference centre; this pose's own feet on the
        # feet line.
        dx = int(round(geo['cx'] * R - ref_cx * k))
        dy = int(round(geo['feet'] * R - feet_y(im) * k))
        canvas.alpha_composite(small, (dx, dy))

        out = os.path.join(out_dir, anim.lower() + '.png')
        canvas.save(out, optimize=True)
        written.append((out, os.path.getsize(out), dx, dy))

    return written


def build_portrait(champ, size=320, pad=0.08):
    """One card-sized portrait, cropped to the character.

    The battle frames keep the engine's generous empty margin, which is
    exactly right in the arena and useless on a design sheet. So the card
    gets a crop instead: the P1 idle pose, trimmed to its own pixels, on a
    square canvas. Not mirrored and not re-laid-out - the portrait is the
    character as supplied.
    """
    src_dir, _ = SOURCES[champ]['p1']
    im = load_pose(os.path.join(ROOT, src_dir, POSE_MAP[champ]['idle'] + '.png'), False)
    bb = bbox(im)
    if not bb:
        return None
    x0, y0, x1, y1 = bb
    crop = im.crop((x0, y0, x1, y1))
    inner = int(size * (1 - pad * 2))
    k = min(inner / float(crop.width), inner / float(crop.height))
    small = crop.resize((max(1, int(crop.width * k)), max(1, int(crop.height * k))),
                        Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(small, ((size - small.width) // 2, (size - small.height) // 2))
    out = os.path.join(ROOT, 'assets', 'img', 'champ', champ, 'portrait.png')
    canvas.save(out, optimize=True)
    return out, os.path.getsize(out)


def main():
    total = 0
    files = 0
    for champ in SOURCES:
        for side in SOURCES[champ]:
            for out, size, dx, dy in build(champ, side):
                total += size
                files += 1
                print('%-58s %7d B  at (%d,%d)' % (
                    os.path.relpath(out, ROOT).replace('\\', '/'), size, dx, dy))
        got = build_portrait(champ)
        if got:
            total += got[1]
            files += 1
            print('%-58s %7d B  portrait' % (
                os.path.relpath(got[0], ROOT).replace('\\', '/'), got[1]))
    print('\n%d files, %.1f MB total' % (files, total / 1048576.0))


if __name__ == '__main__':
    main()
