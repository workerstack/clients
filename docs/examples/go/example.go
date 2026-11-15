// A Go program against an SDK generated from the Kitchen example API: a client, a call and its typed error,
// the same kind of call on the safe mirror answering a Result, an event stream released by breaking out of its
// loop, and the typed streams of the small streaming API beside it. Built and vetted by the docs' tests.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	sdk "example.com/sdk"
)

func newClient() *sdk.Client {
	return sdk.NewClient(sdk.Config{
		BaseURL:     "https://api.example.com",
		BearerToken: os.Getenv("KITCHEN_TOKEN"),
		Timeout:     10 * time.Second,
	})
}

func checkHealth(ctx context.Context, client *sdk.Client) error {
	err := client.Health.Check(ctx, nil)
	var failed *sdk.ClientError
	if errors.As(err, &failed) {
		return fmt.Errorf("health check answered %d: %s", failed.StatusCode, failed.Key)
	}
	return err
}

func listing(ctx context.Context, client *sdk.Client) string {
	r, err := client.Safe().Root.List(ctx, nil)
	if err != nil {
		return fmt.Sprintf("no answer: %v", err) // never sent, refused, dropped, timed out or canceled
	}
	var unreadable *sdk.DecodeError
	var failed *sdk.ClientError
	switch {
	case r.Ok():
		return fmt.Sprintf("answered %d: %v", r.Response.StatusCode, r.Data)
	case errors.As(r.Err, &unreadable):
		return fmt.Sprintf("answered %d, unreadable: %v", r.Response.StatusCode, unreadable.Err)
	case errors.As(r.Err, &failed):
		return fmt.Sprintf("answered %d: %s", failed.StatusCode, failed.Key)
	}
	return r.Err.Error()
}

func firstEvents(ctx context.Context, client *sdk.Client, limit int) ([]string, error) {
	var seen []string
	for event, err := range client.Events.List(ctx, nil) {
		if err != nil {
			return seen, err
		}
		seen = append(seen, event.Untyped().Data) // any event's data as text; a type switch reads it typed
		if len(seen) == limit {
			break // leaving the loop closes the stream and frees its connection
		}
	}
	return seen, nil
}

func ticks(ctx context.Context, client *sdk.Client) ([]int64, error) {
	var at []int64
	for event, err := range client.Ticks.Stream(ctx, nil) {
		if err != nil {
			return at, err
		}
		switch e := event.(type) {
		case sdk.TicksStreamTickEvent: // the name picks the type: Data is a Tick
			at = append(at, e.Data.At)
		default:
			fmt.Println("note", e.Untyped().Data)
		}
	}
	return at, nil
}

func chat(ctx context.Context, client *sdk.Client) error {
	chat, err := client.Chat.Open(ctx, nil)
	if err != nil {
		return err
	}
	defer chat.Close(1000, "")
	chat.OnSaid(func(message sdk.Said) { fmt.Println(message.Text) })
	chat.OnError(func(err error) { fmt.Fprintln(os.Stderr, err) })
	if err := chat.Send(ctx, sdk.Say{Type: "say", Text: "hi"}); err != nil {
		return err
	}
	_, err = chat.Read(ctx) // the handlers run as Read reads
	return err
}

func room(ctx context.Context, client *sdk.Client) error {
	room, err := client.Room.Join(ctx, nil)
	if err != nil {
		return err
	}
	defer room.Close()
	room.OnLeft(func(sdk.RoomLeft) { fmt.Println("someone left") })
	if err := room.Send(ctx, sdk.RoomSay{Type: "say", Text: "hi"}); err != nil {
		return err
	}
	for message := range room.Events() {
		if said, ok := message.(sdk.RoomSaid); ok {
			fmt.Println(said.Text)
		}
	}
	return nil
}

func main() {
	if len(os.Args) < 2 {
		return
	}
	ctx := context.Background()
	client := newClient()
	if err := checkHealth(ctx, client); err != nil {
		fmt.Println(err)
		return
	}
	fmt.Println(listing(ctx, client))
	events, err := firstEvents(ctx, client, 2)
	fmt.Println(events, err)
	at, err := ticks(ctx, client)
	fmt.Println(at, err)
	fmt.Println(chat(ctx, client), room(ctx, client))
}
