package calcite.probe;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/** The angle maths behind smooth aiming and walking. */
class AimTest {

    @Test
    void wrapsAnglesToTheShorterArc() {
        assertEquals(-10, Aim.wrapDegrees(350), 1e-9);
        assertEquals(10, Aim.wrapDegrees(-350), 1e-9);
        assertEquals(-180, Aim.wrapDegrees(180), 1e-9);
        assertEquals(-180, Aim.wrapDegrees(-180), 1e-9);
        assertEquals(0, Aim.wrapDegrees(720), 1e-9);
    }

    @Test
    void stepsTowardsTheTargetWithoutOvershooting() {
        assertEquals(20, Aim.stepAngle(0, 90, 20), 1e-9);
        assertEquals(90, Aim.stepAngle(80, 90, 20), 1e-9);
        assertEquals(-20, Aim.stepAngle(0, -90, 20), 1e-9);
        assertEquals(0, Aim.stepAngle(0, 0, 20), 1e-9);
    }

    @Test
    void turnsTheShorterWayAcrossTheWrap() {
        assertEquals(-170, Aim.stepAngle(170, -170, 20), 1e-9, "a 20° step forwards, reported as -170");
        assertEquals(170, Aim.stepAngle(-170, 170, 20), 1e-9, "a 20° step backwards, reported as 170");
    }

    @Test
    void yawPointsAlongTheAxes() {
        assertEquals(0, Aim.yawTowards(0, 1), 1e-9);
        assertEquals(90, Aim.yawTowards(-1, 0), 1e-9);
        assertEquals(-90, Aim.yawTowards(1, 0), 1e-9);
        assertEquals(180, Math.abs(Aim.yawTowards(0, -1)), 1e-9);
    }
}
