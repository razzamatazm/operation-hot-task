# Marking the Office Closed on Specific Dates

The app won't have a way to mark particular dates, such as holidays, as closed.
The only days it treats as closed are weekends. Every weekday is a working day
with the normal hours, and Friday closes early (#457).

## Why this is out of scope

**Too much to build for the size of the problem.** A closed-days switch needs an
admin screen, somewhere to store the dates, and every reminder, pool nag and
deadline rule checking those dates while the server runs. The office hours are
currently read once when the server starts. All of that would serve roughly ten
days a year.

**The fixes that matter every week are already queued.** The Friday close (#457)
and the overnight nag clock (#459) cover the quiet times that come round every
week. A holiday does less harm: a few nags go to an empty channel, and a task
may use up its asks before anyone is back to read them.

## What would change this

If holiday nags cause real trouble, it's worth reopening. For example, work
gets missed after a long weekend because a task ran out of asks while the
office was shut, or the team complains about being chased on holidays. That
should be something that actually happened, not a gap someone spotted in the
code.

The work that's been done makes this cheaper later. #459 counts time only
while the office is open and gets the hours from one place, so closed dates
would only need adding there.

## Prior requests

- #458 — "Admin switch to mark the office closed for a day or two, so holidays go quiet"
