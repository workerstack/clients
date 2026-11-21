//! The grid's `Setup.recordInvalidate` (plan 8's invalidate-once row): the client's `on_invalidate`
//! hooks record each event they see, after a hook that fails when `failFirst`, and a call's data
//! answer is observed as `invalidated`, carrying the events recorded since the last call.

use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{Value, json};

/// What the setup asks for: a failing hook before the recording one.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RecordInvalidate {
    pub fail_first: bool,
}

/// The events the recording hook saw since the last call, in the grid's shape.
#[derive(Clone, Default)]
pub struct Invalidations(Arc<Mutex<Vec<Value>>>);

/// The error of the hook `failFirst` puts before the recording one: on_log's, never the call's.
const FAILING: &str = "driver: a failing on_invalidate hook";

impl Invalidations {
    /// `config`'s hooks as `ask` wants them: the failing one first when it says so, then the recorder.
    pub fn install(&self, config: &mut sdk::ClientConfig, ask: &RecordInvalidate) {
        if ask.fail_first {
            config.on_invalidate.push(sdk::on_invalidate(|_| async {
                Err::<(), sdk::Error>(sdk::Error::Hook(FAILING.into()))
            }));
        }
        let events = Arc::clone(&self.0);
        config.on_invalidate.push(sdk::on_invalidate(move |e| {
            let events = Arc::clone(&events);
            async move {
                let targets: Vec<Value> = e
                    .targets
                    .iter()
                    .map(|t| json!({"operationId": t.operation_id, "params": t.params}))
                    .collect();
                let event = json!({"by": e.by, "targets": targets});
                events.lock().expect("events").push(event);
                Ok::<(), sdk::Error>(())
            }
        }));
    }

    /// A call's observation under the recorder: a data answer is `invalidated`, with the events
    /// recorded since the last call; any other as it is.
    pub fn observe(&self, mut seen: Value) -> Value {
        if seen["kind"] != "data" {
            return seen;
        }
        let events = std::mem::take(&mut *self.0.lock().expect("events"));
        seen["kind"] = json!("invalidated");
        seen["events"] = json!(events);
        seen
    }
}
