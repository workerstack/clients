using System.Collections;
using System.Reflection;
using System.Text.Json.Nodes;

namespace Http.Driver;

/// <summary>The grid's <c>Setup.recordInvalidate</c> (plan 9): record the hooks' events, after a failing hook under <c>FailFirst</c>.</summary>
internal sealed record RecordInvalidate(bool FailFirst);

/// <summary>
/// The recorder a cell's <c>setup.recordInvalidate</c> asks for (plan 9, Go's plan 6 driver ported): one
/// <c>OnInvalidate</c> hook that records each event in the grid's shape, after one whose Task faults under
/// <c>FailFirst</c>; a call's data answer is then observed as <c>invalidated</c>, with the events recorded since the
/// call before it.
/// </summary>
internal sealed class Invalidations
{
    private readonly Lock gate = new();
    private JsonArray events = [];

    /// <summary>The recorder <paramref name="setup"/> asks for, its hooks on <paramref name="config"/>; null when it asks for none.</summary>
    public static Invalidations? Install(object config, Setup setup)
    {
        if (setup.RecordInvalidate is not { } record)
        {
            return null;
        }
        var recorder = new Invalidations();
        var property = Sdk.PropertyOf(config, "OnInvalidate");
        var func = property.PropertyType.GetGenericArguments()[0];
        string[] methods = record.FailFirst ? [nameof(FailAsync), nameof(RecordAsync)] : [nameof(RecordAsync)];
        var hooks = Array.CreateInstance(func, methods.Length);
        for (var i = 0; i < methods.Length; i++)
        {
            var method = typeof(Invalidations).GetMethod(methods[i], BindingFlags.Public | BindingFlags.Instance)!;
            hooks.SetValue(Delegate.CreateDelegate(func, recorder, method), i);
        }
        property.SetValue(config, hooks);
        return recorder;
    }

    /// <summary>The hook <c>FailFirst</c> puts first: its fault is OnLog's, never the call's.</summary>
    public Task FailAsync(object e, CancellationToken ct) =>
        Task.FromException(new InvalidOperationException("driver: a failing OnInvalidate hook"));

    /// <summary>
    /// Records <paramref name="e"/> (the SDK's <c>InvalidateEvent</c>, bound contravariantly) as
    /// <c>{by, targets: [{operationId, params}]}</c>.
    /// </summary>
    public Task RecordAsync(object e, CancellationToken ct)
    {
        var targets = new JsonArray();
        foreach (var target in (IEnumerable)Sdk.Get(e, "Targets")!)
        {
            var parameters = new JsonObject();
            foreach (var (key, value) in (IEnumerable<KeyValuePair<string, string>>)Sdk.Get(target, "Params")!)
            {
                parameters[key] = value;
            }
            targets.Add(new JsonObject { ["operationId"] = (string?)Sdk.Get(target, "OperationId"), ["params"] = parameters });
        }
        lock (gate)
        {
            events.Add(new JsonObject { ["by"] = (string?)Sdk.Get(e, "By"), ["targets"] = targets });
        }
        return Task.CompletedTask;
    }

    /// <summary>A call's observed node: a data answer as invalidated, with the events since the last call.</summary>
    public JsonNode? Observe(JsonNode? seen)
    {
        if (seen is not JsonObject data || data["kind"]?.GetValue<string>() != "data")
        {
            return seen;
        }
        lock (gate)
        {
            data["kind"] = "invalidated";
            data["events"] = events;
            events = [];
        }
        return data;
    }
}
