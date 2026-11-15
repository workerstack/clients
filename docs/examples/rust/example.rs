// A Rust program against an SDK generated from the Kitchen example API and a small streaming one beside it: a
// client, a call and its typed error, the same kind of call on the safe mirror answering an `Answer`, an event stream
// released by dropping it, typed SSE events, WebSocket and realtime messages, and the async SDK called from blocking
// code. Built by the docs' tests.
use sdk::{Answer, Client, ClientConfig, Error, SafeError};
use sdk::{ChatIn, ChatOut, EventsListEvent, RoomIn, RoomOut, RoomSay, Say, TicksStreamEvent};
use sdk::{ChatOpenOpts, EventsListOpts, HealthCheckOpts, RoomJoinOpts, RootListOpts, TicksStreamOpts};

fn new_client() -> Result<Client, Error> {
    Client::new(ClientConfig {
        base_url: "https://api.example.com".into(),
        bearer_token: std::env::var("KITCHEN_TOKEN").ok(),
        timeout: Some(std::time::Duration::from_secs(10)),
        ..ClientConfig::default()
    })
}

async fn check_health(client: &Client) -> Result<(), String> {
    match client.health().check(&HealthCheckOpts::default()).await {
        Ok(()) => Ok(()),
        Err(Error::Api(failed)) => Err(format!("health check answered {}", failed.status())),
        Err(other) => Err(other.to_string()),
    }
}

async fn listing(client: &Client) -> String {
    match client.safe().root().list(&RootListOpts::default()).await {
        Ok(Answer::Ok { data, response }) => format!("answered {}: {data:?}", response.status),
        Ok(Answer::Err {
            error: SafeError::Api(failed),
            response,
        }) => format!("answered {}: {}", response.status, failed.message()),
        Ok(Answer::Err {
            error: SafeError::Decode(unreadable),
            response,
        }) => format!("answered {}, unreadable: {unreadable}", response.status),
        Err(no_answer) => format!("no answer: {no_answer}"), // never sent, refused, timed out or canceled
    }
}

async fn first_events(client: &Client, limit: usize) -> Result<Vec<String>, Error> {
    let mut stream = client.events().list(&EventsListOpts::default()).await?;
    let mut seen = Vec::new();
    while let Some(event) = stream.next().await {
        seen.push(match event? {
            EventsListEvent::Message(e) | EventsListEvent::Unknown(e) => e.data, // each name's data as text
        });
        if seen.len() == limit {
            break;
        }
    }
    Ok(seen) // dropping the stream closes its connection
}

async fn ticks(client: &Client) -> Result<Vec<i64>, Error> {
    let mut stream = client.ticks().stream(&TicksStreamOpts::default()).await?;
    let mut at = Vec::new();
    while let Some(event) = stream.next().await {
        match event? {
            TicksStreamEvent::Tick(e) => at.push(e.data.at), // the name picks the type: data is a Tick
            TicksStreamEvent::Message(e) | TicksStreamEvent::Unknown(e) => println!("note {}", e.data),
        }
    }
    Ok(at)
}

async fn chat(client: &Client) -> Result<(), Error> {
    let mut chat = client.chat().open(&ChatOpenOpts::default()).await?;
    chat.on_said(|message| println!("{}", message.text));
    chat.on_error(|error| eprintln!("{error}"));
    chat.send(&ChatIn::Say(Say { r#type: "say".into(), text: "hi".into() })).await?;
    if let Some(Ok(ChatOut::Unknown(other))) = chat.recv().await {
        println!("undeclared {other}"); // the handlers ran as recv read it
    }
    Ok(())
}

async fn room(client: &Client) -> Result<(), Error> {
    let mut room = client.room().join(&RoomJoinOpts::default()).await?;
    room.on_left(|_| println!("someone left"));
    room.send(&RoomIn::Say(RoomSay { r#type: "say".into(), text: "hi".into() })).await?;
    while let Some(message) = room.recv().await {
        if let RoomOut::Said(said) = message? {
            println!("{}", said.text);
        }
    }
    Ok(())
}

/// The SDK is async; blocking code drives it with a runtime of its own: one per thread, never inside async code.
fn health_blocking(client: &Client) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(check_health(client))
}

fn main() {
    if std::env::args().len() < 2 {
        return;
    }
    let client = new_client().expect("a valid config");
    println!("{:?}", health_blocking(&client));
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a runtime");
    println!("{}", runtime.block_on(listing(&client)));
    println!("{:?}", runtime.block_on(first_events(&client, 2)).map_err(|error| error.to_string()));
    println!("{:?}", runtime.block_on(ticks(&client)).map_err(|error| error.to_string()));
    println!("{:?} {:?}", runtime.block_on(chat(&client)).is_ok(), runtime.block_on(room(&client)).is_ok());
}
