"""Rigid-body backends for the inspection drone.

`pybullet` steps a real PyBullet world (DIRECT mode, fixed 240 Hz step).
`native` is a dependency-free point-mass integrator for CI and the Pi.
Both are deterministic for a given sequence of commands; the backend name is
part of the mission manifest so a replay uses the same one.
"""
from __future__ import annotations

import math
from typing import List, Sequence

PHYS_HZ = 240
DT = 1.0 / PHYS_HZ
MASS = 1.0
G = 9.81
HALF_H = 0.05  # drone body half-height (m)


def controller(pos: Sequence[float], vel: Sequence[float], target: Sequence[float],
               vmax_xy: float, vmax_z: float = 1.5, kp: float = 1.4, kv: float = 3.5, amax: float = 5.0) -> List[float]:
    """Velocity-limited PD position controller. Returns world-frame thrust force (N)."""
    v_des = [kp * (target[i] - pos[i]) for i in range(3)]
    n = math.hypot(v_des[0], v_des[1])
    if n > vmax_xy:
        v_des[0] *= vmax_xy / n
        v_des[1] *= vmax_xy / n
    v_des[2] = max(-vmax_z, min(vmax_z, v_des[2]))
    a = [kv * (v_des[i] - vel[i]) for i in range(3)]
    na = math.sqrt(a[0] ** 2 + a[1] ** 2 + a[2] ** 2)
    if na > amax:
        a = [c * amax / na for c in a]
    return [MASS * a[0], MASS * a[1], MASS * (a[2] + G)]


class NativeBody:
    name = "native"

    def __init__(self, x: float, y: float, z: float):
        self.p = [x, y, max(z, HALF_H)]
        self.v = [0.0, 0.0, 0.0]

    def step(self, force: Sequence[float]) -> None:
        drag = 0.15
        for i in range(3):
            acc = force[i] / MASS - (G if i == 2 else 0.0) - drag * self.v[i]
            self.v[i] += acc * DT
        for i in range(3):
            self.p[i] += self.v[i] * DT
        if self.p[2] < HALF_H:  # ground contact
            self.p[2] = HALF_H
            if self.v[2] < 0:
                self.v[2] = 0.0
            self.v[0] *= 0.8
            self.v[1] *= 0.8

    def state(self):
        return list(self.p), list(self.v)

    def close(self) -> None:
        pass


class PyBulletBody:
    name = "pybullet"

    def __init__(self, x: float, y: float, z: float):
        import pybullet as p  # imported lazily: optional dependency

        self._p = p
        self.cid = p.connect(p.DIRECT)
        p.resetSimulation(physicsClientId=self.cid)
        p.setPhysicsEngineParameter(fixedTimeStep=DT, numSolverIterations=50,
                                    deterministicOverlappingPairs=1, physicsClientId=self.cid)
        p.setGravity(0, 0, -G, physicsClientId=self.cid)
        plane = p.createCollisionShape(p.GEOM_PLANE, physicsClientId=self.cid)
        p.createMultiBody(0, plane, physicsClientId=self.cid)
        box = p.createCollisionShape(p.GEOM_BOX, halfExtents=[0.15, 0.15, HALF_H], physicsClientId=self.cid)
        self.body = p.createMultiBody(MASS, box, basePosition=[x, y, max(z, HALF_H)], physicsClientId=self.cid)
        p.changeDynamics(self.body, -1, linearDamping=0.0, angularDamping=0.9, lateralFriction=0.8,
                         physicsClientId=self.cid)

    def step(self, force: Sequence[float]) -> None:
        p = self._p
        pos, _ = p.getBasePositionAndOrientation(self.body, physicsClientId=self.cid)
        p.applyExternalForce(self.body, -1, list(force), list(pos), p.WORLD_FRAME, physicsClientId=self.cid)
        p.stepSimulation(physicsClientId=self.cid)
        # Attitude is held by the (unmodelled) inner rate loop: keep the body level.
        pos, orn = p.getBasePositionAndOrientation(self.body, physicsClientId=self.cid)
        if abs(orn[0]) + abs(orn[1]) + abs(orn[2]) > 1e-9:
            lin, _ = p.getBaseVelocity(self.body, physicsClientId=self.cid)
            p.resetBasePositionAndOrientation(self.body, pos, [0, 0, 0, 1], physicsClientId=self.cid)
            p.resetBaseVelocity(self.body, lin, [0, 0, 0], physicsClientId=self.cid)

    def state(self):
        p = self._p
        pos, _ = p.getBasePositionAndOrientation(self.body, physicsClientId=self.cid)
        lin, _ = p.getBaseVelocity(self.body, physicsClientId=self.cid)
        return list(pos), list(lin)

    def close(self) -> None:
        try:
            self._p.disconnect(physicsClientId=self.cid)
        except Exception:
            pass


def available_backends() -> List[str]:
    out = ["native"]
    try:
        import pybullet  # noqa: F401

        out.insert(0, "pybullet")
    except Exception:
        pass
    return out


def make_body(backend: str, x: float, y: float, z: float):
    if backend == "pybullet":
        return PyBulletBody(x, y, z)
    if backend == "native":
        return NativeBody(x, y, z)
    raise ValueError(f"unknown physics backend {backend!r}")
