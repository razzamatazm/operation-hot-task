# A Screen That Shows a Task's History

This app does not, and will not, render a task's history log as a view a person
can open. The log is a stored record read back through the API when somebody
genuinely needs it. It is not a product surface.

To be precise about what is rejected: the **screen**, not the **logging**.
Every rule that writes a history row still writes it, still carries both sides
of a change, and is still append-only. Nothing below is an argument for logging
less.

## Why this is out of scope

**The log is written for durability, not for reading.** Every row's description
is a free-text sentence, and an accepted decision is explicit that this string
is nobody's parser. Some of them read fine to a person ("Claimed by Dana
Wells"). The single most common row in the store is the generic status change,
which reads:

```
CLAIMED -> COMPLETED
```

That is about 40% of all rows. Putting a screen over this means one of two
things, and both are worse than they look. Show the sentences raw, and you have
shipped a server log to loan operations staff. Build a presentation layer that
renders each action type nicely, and you have taken on a permanent tax: every
future logged action needs a matching display rule, or it silently falls back
to the raw sentence and the screen degrades one row at a time.

**Nobody was asking for it.** The demand was inferred from the log's existence
rather than observed in use. The three things the app actually reads out of the
log today are who took the task, who completed it, and who archived it, and all
three are already answered in the task's hamburger menu, which is where
reference detail belongs. That covers the questions that were genuinely being
asked. What a full history screen adds beyond those is reconstruction of a
shift, which comes up rarely and is not time-critical when it does.

**The audience is small and the escape hatch is real.** This is an internal
tool. When a question needs the underlying rows, someone with API access
fetches them. That is a fine answer for something that happens a handful of
times a year, and it is a bad trade against a permanently maintained view.

**The visibility question was never actually settled, and a screen forces it.**
The log is readable more widely than the conversation it describes: the
endpoint does not currently check who is asking at all. That was accepted
knowingly for stored data, on the reasoning that an edit to an LOI's terms
already lands there under the same visibility. Putting a screen on it is the
moment that becomes a product decision about who can read whose withdrawn
messages, and answering it properly is server work, not a panel. Declining the
screen leaves the question where it was rather than forcing a rushed answer.

## What this obliges the docs to do

Because the log stays unreadable in-app, no UI copy and no decision record may
imply otherwise. Two sentences were rewritten when this was decided:

- The design reference said an edited message offers no route back to the
  previous wording because "that lives in the task's history", which reads as a
  pointer to a screen. It now says the wording is kept in a stored record read
  back through the API.
- The no-undo rule for deleted messages leaned on the original text surviving
  "for the rare case that matters". Still true, and now explicit that recovery
  is not something the author can do for themselves.

The rule to carry forward: history is where the app *keeps* an answer, never
where it *sends a person to look*.

## What would change this

Not a hypothetical. This gets reopened if ops staff start asking, unprompted,
what a task used to say, and the API escape hatch is visibly failing them. Two
or three real requests from people doing the work, rather than a gap noticed
while reading the code.

## Prior requests

- #289 — "Nothing in the app shows a task's history"
