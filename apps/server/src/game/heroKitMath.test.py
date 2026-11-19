"""The hero kit's pure math (blender-kit/kurambit/gait.py, gates.py, proportions.py), run by
heroKitMath.test.ts with python3 and numpy; no Blender needed."""
import math
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "templates", "blender-kit", "kurambit"))

import gait  # noqa: E402
import gates  # noqa: E402
import proportions  # noqa: E402

QUAD = [
    {"name": "hl", "foot": (0.05, 0.1, 0.0), "front": False, "side": 1, "length": 0.15},
    {"name": "hr", "foot": (-0.05, 0.1, 0.0), "front": False, "side": -1, "length": 0.15},
    {"name": "fl", "foot": (0.05, -0.1, 0.0), "front": True, "side": 1, "length": 0.15},
    {"name": "fr", "foot": (-0.05, -0.1, 0.0), "front": True, "side": -1, "length": 0.15},
]


class Gait(unittest.TestCase):
    def test_a_foot_track_closes_its_loop(self):
        for duty in (0.36, 0.5, 0.68):
            a = gait.foot_track(0.0, duty, 0.2, 0.05)
            b = gait.foot_track(1.0 - 1e-9, duty, 0.2, 0.05)
            self.assertAlmostEqual(a[0], b[0], places=5)
            self.assertAlmostEqual(a[1], b[1], places=5)

    def test_planted_feet_do_not_skate_at_ground_speed(self):
        for name in ("walk", "trot", "run"):
            cyc = gait.walk_cycle(QUAD, name, fps=30)
            for leg in QUAD:
                track = np.array([p["feet"][leg["name"]]["at"] for p in cyc["poses"]])
                planted = [p["feet"][leg["name"]]["planted"] for p in cyc["poses"]]
                self.assertTrue(any(planted))
                self.assertTrue(np.allclose(track[np.array(planted)][:, 2], 0.0))
                worst, _ = gait.slide(track, planted, cyc["groundSpeed"], 30)
                self.assertLess(worst, 1e-6, f"{name} {leg['name']}")

    def test_a_trot_moves_diagonal_pairs_together(self):
        cyc = gait.walk_cycle(QUAD, "trot", fps=30)
        for p in cyc["poses"]:
            self.assertEqual(p["feet"]["hl"]["planted"], p["feet"]["fr"]["planted"])
            self.assertEqual(p["feet"]["hr"]["planted"], p["feet"]["fl"]["planted"])

    def test_each_foot_is_planted_for_its_duty(self):
        for name in ("walk", "trot", "run"):
            cyc = gait.walk_cycle(QUAD, name, fps=60)
            share = np.mean([p["feet"]["hl"]["planted"] for p in cyc["poses"]])
            self.assertAlmostEqual(share, gait.GAITS[name]["duty"], delta=1.5 / cyc["frames"])

    def test_ground_speed_is_stride_over_stance_time(self):
        frames, stride, speed = gait.timing(0.3, "walk", 30, stride=0.25)
        self.assertAlmostEqual(speed, stride / (gait.GAITS["walk"]["duty"] * frames / 30))


class Gates(unittest.TestCase):
    def test_strain_reads_spread_worst_and_squash(self):
        rest = np.full(2000, 0.02)
        posed = rest.copy()
        posed[7] = 0.2
        posed[8] = 0.002
        s = gates.strain(rest, posed, 0.01)
        self.assertAlmostEqual(s["worst"], 10.0)
        self.assertEqual(s["edge"], 7)
        self.assertLess(s["spread"], 1.5)
        self.assertTrue(gates.deformation(s["spread"], 2.0, s["squash"]))
        self.assertFalse(gates.deformation(s["spread"], s["worst"], s["squash"]))
        self.assertIsNone(gates.strain(rest, posed, 0.05))

    def test_depth_is_positive_inside(self):
        pts = np.array([[0, 0, -0.1], [0, 0, 0.05]])
        near = np.array([[0, 0, 0.0], [0, 0, 0.0]])
        nrm = np.array([[0, 0, 1.0], [0, 0, 1.0]])
        d = gates.depths(pts, near, nrm)
        self.assertAlmostEqual(d[0], 0.1)
        self.assertLess(d[1], 0)
        depth, i, share = gates.sunk(np.array([0.05, 0.03]), np.array([0.04, -0.01]))
        self.assertAlmostEqual(depth, 0.03)
        self.assertEqual(i, 1)

    def test_feet_read_contact_and_slide(self):
        fps, speed = 30, 0.6
        n = 30
        t = np.arange(n) / fps
        track = np.stack([np.zeros(n), -0.2 + speed * t, np.full(n, 0.01)], axis=1)  # back at speed
        planted = gates.plants(track, 0.01)
        contact, _, slide, _ = gates.feet(track, 0.0, planted, speed, fps)
        self.assertAlmostEqual(contact, 0.01)
        self.assertLess(slide, 1e-9)
        drift = track.copy()
        drift[:, 0] += np.linspace(0, 0.05, n)  # sliding sideways 5 cm
        contact, _, slide, _ = gates.feet(drift, 0.0, planted, speed, fps)
        self.assertAlmostEqual(slide, 0.05, places=6)
        self.assertAlmostEqual(gates.ground_speed({"f": track}, {"f": 0.01}, fps), speed)

    def test_height_and_budget(self):
        self.assertTrue(gates.height(1.72, 1.5, 2.0)["pass"])
        self.assertFalse(gates.height(2.63, 1.5, 2.0)["pass"])
        b = gates.budget(25000, 3, [{"width": 2048, "height": 1024}], {"triangles": 20000, "texture": 1024})
        self.assertFalse(b["pass"])
        self.assertIn("25000 triangles over 20000", b["text"])


MARKS = {
    "pelvis": (0, 0, 1.0), "spine_03": (0, 0, 1.35), "neck_01": (0, 0, 1.5), "Head": (0, 0, 1.6),
    "thigh_l": (0.1, 0, 0.95), "thigh_r": (-0.1, 0, 0.95), "calf_l": (0.1, 0, 0.5), "calf_r": (-0.1, 0, 0.5),
    "foot_l": (0.1, 0, 0.08), "foot_r": (-0.1, 0, 0.08), "upperarm_l": (0.2, 0, 1.42), "upperarm_r": (-0.2, 0, 1.42),
    "hand_l": (0.45, 0, 1.0), "hand_r": (-0.45, 0, 1.0),
}


class Proportions(unittest.TestCase):
    def test_region_maps_agree_where_regions_meet(self):
        f = proportions.resolve({"preset": "chibi"})
        m = proportions.maps(MARKS, f)
        at = lambda name: np.array([MARKS[name]], float)  # noqa: E731
        pairs = [("torso", "legs", "thigh_l"), ("torso", "arms", "upperarm_l"), ("arms", "hands", "hand_l"),
                 ("torso", "neck", "neck_01"), ("neck", "head", "Head"), ("legs", "feet", "foot_l")]
        for a, b, joint in pairs:
            np.testing.assert_allclose(m[a](at(joint)), m[b](at(joint)), atol=1e-9, err_msg=f"{a}/{b} at {joint}")

    def test_a_chibi_has_a_bigger_head_and_shorter_legs(self):
        m = proportions.maps(MARKS, proportions.resolve({"preset": "chibi"}))
        top = m["head"](np.array([[0, 0, 1.8]]))[0]
        neck = m["head"](np.array([MARKS["Head"]], float))[0]
        self.assertAlmostEqual(top[2] - neck[2], 0.2 * 2.0)
        hip = m["legs"](np.array([MARKS["thigh_l"]], float))[0]
        self.assertAlmostEqual(hip[2], 0.08 + (0.95 - 0.08) * 0.55)

    def test_blend_and_height(self):
        m = proportions.maps(MARKS, proportions.resolve({"head": 1.5}))
        pts = np.array([[0, 0, 1.7], [0.3, 0.3, 0.3]])
        w = np.zeros((2, len(proportions.REGIONS)))
        w[0, proportions.REGIONS.index("head")] = 1.0
        out = proportions.blend(pts, w, m)
        np.testing.assert_allclose(out[0], m["head"](pts[:1])[0])
        np.testing.assert_allclose(out[1], pts[1])
        scaled, k = proportions.to_height(np.array([[0, 0, 0.0], [0, 0, 2.0]]), 0.0, 2.0, 1.0)
        self.assertAlmostEqual(scaled[1, 2], 1.0)
        self.assertAlmostEqual(k, 0.5)
        with self.assertRaises(ValueError):
            proportions.resolve({"preset": "gothic"})


if __name__ == "__main__":
    unittest.main()
