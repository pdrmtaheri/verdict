---- MODULE interleave ----
\* scope: createController() in public/controller.js with its six-phase cycle, emergency(axis) for both axes,
\* clear(), fault(), recover(), and the clock stepping a phase at a time or jumping backwards.
\* Time is abstracted to "the current phase ends" (Tick); durations are not modeled. Rendering in app.js is not covered.
\* models: public/controller.js 1927a426eb10
EXTENDS Naturals

VARIABLES mode, i, hold, faulting
vars == <<mode, i, hold, faulting>>

\* controller.js: PHASES indexes 0..5 (NS green, NS yellow, all red, EW green, EW yellow, all red)
NsLight(p) == IF p = 0 THEN "green" ELSE IF p = 1 THEN "yellow" ELSE "red"
EwLight(p) == IF p = 3 THEN "green" ELSE IF p = 4 THEN "yellow" ELSE "red"
Go(l) == l = "green" \/ l = "yellow"

\* controller.js: state() -- fault mode shows red/red, else PHASES[i]
Ns == IF mode = "fault" THEN "red" ELSE NsLight(i)
Ew == IF mode = "fault" THEN "red" ELSE EwLight(i)

GreenOf(a) == IF a = "ns" THEN 0 ELSE 3   \* controller.js: GREEN
AllRed(p) == p = 2 \/ p = 5

Init == mode = "cycle" /\ i = 0 /\ hold = "none" /\ faulting = FALSE

\* controller.js: advance() -- one phase ends. A held green stays; a pending fault stops at all red.
Tick ==
  /\ mode = "cycle"
  /\ ~(hold /= "none" /\ i = GreenOf(hold))
  /\ i' = (i + 1) % 6
  /\ IF faulting /\ AllRed((i + 1) % 6)
        THEN mode' = "fault" /\ faulting' = FALSE
        ELSE mode' = mode /\ faulting' = faulting
  /\ hold' = hold

\* controller.js: advance() -- time went backwards: cycle restarts from phase 0
ClockBack ==
  /\ mode = "cycle"
  /\ i' = 0
  /\ UNCHANGED <<mode, hold, faulting>>

\* controller.js: emergency(axis)
Emergency(a) ==
  /\ mode = "cycle" /\ ~faulting /\ hold = "none"
  /\ hold' = a
  /\ UNCHANGED <<mode, i, faulting>>

\* controller.js: clear()
Clear ==
  /\ hold /= "none"
  /\ hold' = "none"
  /\ UNCHANGED <<mode, i, faulting>>

\* controller.js: fault()
Fault ==
  /\ mode = "cycle"
  /\ hold' = "none"
  /\ IF AllRed(i)
        THEN mode' = "fault" /\ faulting' = faulting
        ELSE mode' = mode /\ faulting' = TRUE
  /\ UNCHANGED i

\* controller.js: recover()
Recover ==
  /\ mode = "fault"
  /\ mode' = "cycle" /\ faulting' = FALSE /\ hold' = "none" /\ i' = 2

Next == Tick \/ ClockBack \/ Emergency("ns") \/ Emergency("ew") \/ Clear \/ Fault \/ Recover

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ mode \in {"cycle", "fault"}
  /\ i \in 0..5
  /\ hold \in {"none", "ns", "ew"}
  /\ faulting \in BOOLEAN

NeverBothGo == ~(Go(Ns) /\ Go(Ew))
====
