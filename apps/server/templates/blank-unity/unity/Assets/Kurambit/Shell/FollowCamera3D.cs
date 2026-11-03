using UnityEngine;
using UnityEngine.InputSystem;

// A third-person follow camera: behind and above the target, lagging, looking
// a little ahead, pulled in when level geometry is between it and the target
// so it never ends inside a wall. Drag with the right mouse button (or with
// the cursor locked) or the right stick to orbit; untouched while the target
// moves, it settles behind the target's facing. Juice.Shake still applies on
// top (it moves the camera only while it renders).
//
//   var cam = Camera.main.gameObject.AddComponent<FollowCamera3D>();   // or add it in the scene builder
//   cam.target = player.transform;            // the player's own colliders never block it
//   // camera-relative movement: Vector3 dir = cam.Flat(Controls.Move());
//
// Walls block it through their colliders on `blockers` (every layer but
// Ignore Raycast by default); put see-through things on another layer.
[DisallowMultipleComponent]
public sealed class FollowCamera3D : MonoBehaviour
{
    public Transform target;
    public float distance = 6f;
    [Tooltip("The point looked at, above the target's origin.")]
    public float height = 1.6f;
    [Tooltip("Higher catches up faster.")]
    public float lag = 10f;
    public float lookAhead = 1.5f;
    public bool orbit = true;
    [Tooltip("Degrees per pixel of mouse drag.")]
    public float sensitivity = 0.2f;
    [Tooltip("Degrees; positive looks down.")]
    public float pitch = 18f;
    public float minPitch = -20f;
    public float maxPitch = 65f;
    public LayerMask blockers = ~(1 << 2);
    public float radius = 0.25f;

    /// <summary>The view's heading around y, in degrees.</summary>
    public float yaw;

    private Vector3 pivot;
    private Vector3 ahead;
    private Vector3 last;
    private float idle;
    private float arm;
    private bool placed;
    private readonly RaycastHit[] hits = new RaycastHit[16];

    /// <summary>The view's facing on the ground, for camera-relative movement: x right, y forward.</summary>
    public Vector3 Flat(Vector2 input)
    {
        var turn = Quaternion.Euler(0f, yaw, 0f);
        return turn * new Vector3(input.x, 0f, input.y);
    }

    private void Place()
    {
        if (target == null) return;
        yaw = target.eulerAngles.y;
        pivot = target.position + Vector3.up * height;
        last = target.position;
        arm = distance;
        placed = true;
    }

    private void LateUpdate()
    {
        if (target == null) return;
        if (!placed) Place();
        var delta = Time.deltaTime;
        if (delta <= 0f) return;
        var turn = Vector2.zero;
        if (orbit && GameState.IsPlaying)
        {
            var mouse = Mouse.current;
            if (mouse != null && (mouse.rightButton.isPressed || Cursor.lockState == CursorLockMode.Locked))
                turn += mouse.delta.ReadValue() * sensitivity;
            var pad = Gamepad.current;
            if (pad != null)
            {
                var stick = pad.rightStick.ReadValue();
                if (stick.magnitude > 0.15f) turn += new Vector2(stick.x * 150f, -stick.y * 90f) * delta;
            }
        }
        yaw += turn.x;
        pitch = Mathf.Clamp(pitch - turn.y, minPitch, maxPitch);
        var at = target.position;
        var moved = (at - last) / delta;
        last = at;
        moved.y = 0f;
        idle = turn != Vector2.zero ? 0f : idle + delta;
        // Untouched for a moment and moving: swing behind the target's facing.
        if (idle > 1f && moved.magnitude > 0.7f)
            yaw = Mathf.LerpAngle(yaw, target.eulerAngles.y, 1f - Mathf.Exp(-1.5f * delta));
        var want = moved.magnitude > 0.5f ? moved.normalized * lookAhead : Vector3.zero;
        ahead = Vector3.Lerp(ahead, want, 1f - Mathf.Exp(-2.5f * delta));
        pivot = Vector3.Lerp(pivot, at + Vector3.up * height + ahead, 1f - Mathf.Exp(-lag * delta));
        var rotation = Quaternion.Euler(pitch, yaw, 0f);
        var back = rotation * Vector3.back;
        var reach = Reach(pivot, back, distance);
        // The view of the body counts too: a wall lower than the look point can still hide the player.
        var body = target.position + Vector3.up * (height * 0.5f);
        var sight = pivot + back * reach - body;
        var seen = Reach(body, sight.normalized, sight.magnitude);
        if (seen < sight.magnitude) reach *= seen / sight.magnitude;
        reach = Mathf.Max(0.3f, reach - 0.1f);
        // Pull in at once, ease back out, so a wall never shows from inside.
        arm = reach < arm ? reach : Mathf.Lerp(arm, reach, 1f - Mathf.Exp(-4f * delta));
        transform.SetPositionAndRotation(pivot + back * arm, rotation);
    }

    /// <summary>How far a sphere travels from `from` before level geometry stops it, up to `length`.</summary>
    private float Reach(Vector3 from, Vector3 direction, float length)
    {
        var count = Physics.SphereCastNonAlloc(from, radius, direction, hits, length, blockers, QueryTriggerInteraction.Ignore);
        var nearest = length;
        for (var i = 0; i < count; i++)
        {
            var hit = hits[i].transform;
            if (hit == target || hit.IsChildOf(target)) continue;
            if (hits[i].distance > 0f && hits[i].distance < nearest) nearest = hits[i].distance;
        }
        return nearest;
    }
}
