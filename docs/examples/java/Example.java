// A Java program against an SDK generated from the Kitchen example API and a small streaming one beside it: a client,
// a call and its typed error, the client.safe() twin's Result, an event stream released by try-with-resources, and
// typed SSE events, WebSocket and realtime messages. Compiled against the generated SDK in the docs' tests.
import com.example.kitchen.ApiException;
import com.example.kitchen.ChatIn;
import com.example.kitchen.ChatInSay;
import com.example.kitchen.ChatOpenParams;
import com.example.kitchen.ChatOut;
import com.example.kitchen.ChatOutSocket;
import com.example.kitchen.ChatOutUnknown;
import com.example.kitchen.EventStream;
import com.example.kitchen.EventsListEvent;
import com.example.kitchen.EventsListParams;
import com.example.kitchen.HealthCheckParams;
import com.example.kitchen.RootListParams;
import com.example.kitchen.KitchenClient;
import com.example.kitchen.ListApiResponse200;
import com.example.kitchen.Result;
import com.example.kitchen.RoomIn;
import com.example.kitchen.RoomInSay;
import com.example.kitchen.RoomJoinParams;
import com.example.kitchen.RoomOut;
import com.example.kitchen.RoomOutConnection;
import com.example.kitchen.RoomOutSaid;
import com.example.kitchen.RoomSay;
import com.example.kitchen.Say;
import com.example.kitchen.TicksStreamEvent;
import com.example.kitchen.TicksStreamParams;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

public final class Example {
  private Example() {}

  static KitchenClient newClient() {
    return KitchenClient.builder()
        .baseUrl("https://api.example.com")
        .bearerToken(System.getenv("KITCHEN_TOKEN"))
        .timeout(Duration.ofSeconds(10))
        .build();
  }

  static String checkHealth(KitchenClient client) {
    try {
      client.health().check(HealthCheckParams.builder().build());
      return null;
    } catch (ApiException failed) {
      return "health check answered " + failed.status();
    }
  }

  static String listing(KitchenClient client) {
    // no answer (never sent, refused, timed out, canceled) still throws
    Result<ListApiResponse200> result = client.safe().root().list(RootListParams.builder().build());
    int status = result.response().status();
    return result.fold(
        found -> "answered " + status + ": " + found,
        error ->
            error instanceof ApiException failed
                ? "answered " + status + ": " + failed.key()
                : "answered " + status + ", unreadable: " + error.getMessage());
  }

  static List<String> firstEvents(KitchenClient client, int limit) {
    List<String> seen = new ArrayList<>();
    // try-with-resources frees the connection, a break out of the loop included
    try (EventStream<EventsListEvent> stream =
        client.events().list(EventsListParams.builder().build())) {
      for (EventsListEvent event : stream) {
        if (event instanceof EventsListEvent.Message message) {
          seen.add(message.data());
        }
        if (seen.size() == limit) {
          break;
        }
      }
    }
    return seen;
  }

  static List<Long> ticks(KitchenClient client) {
    List<Long> at = new ArrayList<>();
    try (EventStream<TicksStreamEvent> stream =
        client.ticks().stream(TicksStreamParams.builder().build())) {
      for (TicksStreamEvent event : stream) {
        if (event instanceof TicksStreamEvent.TickEvent tick) {
          at.add(tick.data().at()); // the name picks the type: data() is a Tick
        } else if (event instanceof TicksStreamEvent.Unknown other) {
          System.out.println(other.event() + ": " + other.data());
        }
      }
    }
    return at;
  }

  static void chat(KitchenClient client) {
    try (ChatOutSocket<ChatIn> chat = client.chat().open(ChatOpenParams.builder().build())) {
      chat.onSaid(message -> System.out.println(message.text()));
      chat.onError(error -> System.err.println(error.getMessage()));
      chat.send(new ChatInSay(new Say("hi", "say"))); // a member of ChatIn, sent as JSON
      ChatOut read = chat.receive(); // null once the socket ended
      if (read instanceof ChatOutUnknown other) {
        System.out.println("undeclared " + other.value()); // the handlers ran as receive read it
      }
    }
  }

  static void room(KitchenClient client) {
    try (RoomOutConnection<RoomIn> room = client.room().join(RoomJoinParams.builder().build())) {
      room.onLeft(left -> System.out.println("someone left"));
      room.send(new RoomInSay(new RoomSay("hi", "say")));
      for (RoomOut message : room) {
        if (message instanceof RoomOutSaid said) {
          System.out.println(said.value().text());
        }
      }
    }
  }

  public static void main(String[] args) {
    if (args.length < 1) {
      return;
    }
    KitchenClient client = newClient();
    System.out.println(checkHealth(client));
    System.out.println(listing(client));
    System.out.println(firstEvents(client, 2));
    System.out.println(ticks(client));
    chat(client);
    room(client);
  }
}
