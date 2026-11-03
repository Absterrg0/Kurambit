using UnityEngine;

// A 2D (or top-down, looking down the z axis) follow camera: smoothing, a dead
// zone the target moves in freely, a look-ahead in the moving direction, and
// level bounds the view never leaves. Juice.Shake still applies on top.
//
//   var cam = Camera.main.gameObject.AddComponent<FollowCamera2D>();   // or in the scene builder
//   cam.target = player.transform;
//   cam.bounds = level.Bounds2D;              // LevelMap bounds; a zero size means no limits
//
// Units are world units; an orthographic camera's view is orthographicSize * 2 tall.
[DisallowMultipleComponent]
public sealed class FollowCamera2D : MonoBehaviour
{
    public Transform target;
    [Tooltip("World units ahead in the moving direction.")]
    public float lookAhead = 1.5f;
    [Tooltip("The dead zone, as a fraction of half the view (0 follows at once).")]
    public Vector2 deadZone = new Vector2(0.15f, 0.2f);
    [Tooltip("Higher catches up faster.")]
    public float smoothing = 6f;
    [Tooltip("The level's edges; a zero size means no limits.")]
    public Rect bounds;

    private Camera view;
    private Vector2 focus;
    private Vector2 ahead;
    private Vector2 last;
    private bool placed;

    private void LateUpdate()
    {
        if (target == null) return;
        if (view == null) view = GetComponent<Camera>();
        Vector2 at = target.position;
        if (!placed)
        {
            focus = at;
            last = at;
            placed = true;
        }
        var delta = Time.deltaTime;
        if (delta <= 0f) return;
        var half = HalfView();
        // The dead zone: the focus moves only as far as the target leaves it.
        var zone = Vector2.Scale(half, deadZone);
        var offset = at - focus;
        if (Mathf.Abs(offset.x) > zone.x) focus.x = at.x - Mathf.Sign(offset.x) * zone.x;
        if (Mathf.Abs(offset.y) > zone.y) focus.y = at.y - Mathf.Sign(offset.y) * zone.y;
        var moved = (at - last) / delta;
        last = at;
        var want = moved.magnitude > 0.5f ? moved.normalized * lookAhead : Vector2.zero;
        ahead = Vector2.Lerp(ahead, want, 1f - Mathf.Exp(-2.5f * delta));
        var goal = Clamp(focus + ahead, half);
        Vector2 now = transform.position;
        var next = Vector2.Lerp(now, goal, 1f - Mathf.Exp(-smoothing * delta));
        transform.position = new Vector3(next.x, next.y, transform.position.z);
    }

    private Vector2 HalfView()
    {
        if (view == null || !view.orthographic) return new Vector2(8f, 4.5f);
        return new Vector2(view.orthographicSize * view.aspect, view.orthographicSize);
    }

    private Vector2 Clamp(Vector2 point, Vector2 half)
    {
        if (bounds.size == Vector2.zero) return point;
        var x = bounds.width <= half.x * 2f ? bounds.center.x : Mathf.Clamp(point.x, bounds.xMin + half.x, bounds.xMax - half.x);
        var y = bounds.height <= half.y * 2f ? bounds.center.y : Mathf.Clamp(point.y, bounds.yMin + half.y, bounds.yMax - half.y);
        return new Vector2(x, y);
    }
}
