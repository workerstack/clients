import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The recorder a cell's {@code setup.recordInvalidate} asks for (plan 9, Go's plan 6 driver ported):
 * one {@code onInvalidate} hook that records each event in the grid's shape, after one that throws
 * under {@code failFirst}; a call's data answer is then observed as {@code invalidated}, with the
 * events recorded since the call before it.
 */
final class Invalidations {
  private ArrayNode events = Wire.array();

  private Invalidations() {}

  /** The recorder {@code setup} asks for, its hooks on {@code builder}; null when it asks for none. */
  static Invalidations install(Sdk sdk, Object builder, JsonNode setup) {
    JsonNode record = Wire.member(setup, "recordInvalidate");
    if (record == null) {
      return null;
    }
    Invalidations recorder = new Invalidations();
    if (Wire.flag(record, "failFirst")) {
      Reflect.call(builder, "onInvalidate", hook(sdk, recorder, true));
    }
    Reflect.call(builder, "onInvalidate", hook(sdk, recorder, false));
    return recorder;
  }

  /** The SDK's InvalidateHook: one that throws when {@code failing}, else one recording the event. */
  private static Object hook(Sdk sdk, Invalidations recorder, boolean failing) {
    return Proxy.newProxyInstance(
        Invalidations.class.getClassLoader(),
        new Class<?>[] {sdk.type("InvalidateHook")},
        (proxy, method, args) -> {
          if (failing) {
            throw new IllegalStateException("driver: a failing onInvalidate hook");
          }
          recorder.record(args[0]);
          return null;
        });
  }

  /** {@code event} (the SDK's InvalidateEvent) as {@code {by, targets: [{operationId, params}]}}. */
  private synchronized void record(Object event) {
    ArrayNode targets = Wire.array();
    for (Object target : (List<?>) Reflect.call(event, "targets")) {
      ObjectNode params = Wire.object();
      for (Map.Entry<?, ?> param : ((Map<?, ?>) Reflect.call(target, "params")).entrySet()) {
        params.put(String.valueOf(param.getKey()), String.valueOf(param.getValue()));
      }
      ObjectNode one = Wire.object().put("operationId", (String) Reflect.call(target, "operationId"));
      one.set("params", params);
      targets.add(one);
    }
    ObjectNode shown = Wire.object().put("by", (String) Reflect.call(event, "by"));
    shown.set("targets", targets);
    events.add(shown);
  }

  /** A call's observed node: a data answer as invalidated, with the events since the last call. */
  synchronized JsonNode observe(JsonNode seen) {
    if (!(seen instanceof ObjectNode data) || !"data".equals(Wire.text(data, "kind"))) {
      return seen;
    }
    data.put("kind", "invalidated");
    data.set("events", events);
    events = Wire.array();
    return data;
  }
}
