# CLAUDE.md — Theo's Fight Project Context

## What this project is

**Theo's Fight** (theosfight.co.uk) is a FREE UK grant finder for families of children with additional needs. Families enter their child's details, the site searches for matching equipment grants (wheelchairs, AAC devices, sensory equipment etc), and drafts a personalised application letter they can copy and send.

Built by **Andy Hutton** — dad to Theo, aged 8, who has cerebral palsy and is a full-time wheelchair user. Andy is a beginner coder who built this entirely with AI assistance. The site launched ~22 April 2026 and is live in production with real families using it daily.

**This is not a commercial product. It is free, always, for every family. That is non-negotiable.**

## Tech stack

- **Backend:** Node.js + Express (`server.js`)
- **AI:** Anthropic Claude API (Sonnet) for grant search + letter drafting
- **Hosting:** Vercel (auto-deploys from GitHub main branch)
- **Repo:** github.com/Andy-Hutton/theos-fight
- **Domain:** Namecheap (theosfight.co.uk)
- **Email:** Google Workspace (hello@theosfight.co.uk), nodemailer with Gmail app password
- **Email marketing:** Brevo (free tier) — subscribe modal, double opt-in, domain authenticated (DKIM/DMARC green)
- **Analytics:** GA4 (G-3T4248KEPM) with custom events: grant_search, draft_generated, letter_copied, grant_link_clicked
- **Search Console:** connected, sitemap.xml submitted

## File structure

```
/server.js              — Express server, all API endpoints, Helmet CSP, rate limiting
/vercel.json            — routes /search-grants, /draft-application, /report-grant, /submit-feedback → server.js; everything else → public/
/.env                   — EMAIL_USER, EMAIL_PASS, ANTHROPIC_API_KEY (also set in Vercel env)
/public/
  index.html            — main grant finder (form → loading → results → draft modal → subscribe modal)
  about.html, contact.html, privacy.html, feedback.html, testimonials.html
  blog/index.html       — blog homepage
  blog/wheelchair-grants-uk.html
  blog/cerebral-palsy-equipment-grants.html
  blog/aac-communication-device-funding-children-uk.html
  blog/family-fund-application-tips.html
  blog/what-equipment-can-disability-grants-fund.html
  monkey.webp            — mascot (illustrated monkey holding a T)
  manifest.json, sw.js   — PWA (installable, offline cache)
  sitemap.xml            — includes all pages + 5 blog articles
```

## Server endpoints

- `POST /search-grants` — sends family details to Claude API, returns matched grants JSON
- `POST /draft-application` — generates personalised application letter
- `POST /report-grant` — emails hello@ when a family flags a broken/outdated grant link
- `POST /submit-feedback` — feedback form → email to hello@

## Key implementation details

- **Helmet CSP** is strict. scriptSrc includes 'unsafe-inline', 'unsafe-eval', https://sibforms.com. connectSrc and frameSrc include sibforms.com and d98e95d1.sibforms.com (Brevo). Breaking CSP breaks the subscribe form — test after any server.js change.
- **Brevo subscribe modal** uses an iframe embed (NOT Brevo's main.js — it conflicted and was removed). Modal pops 1.5s after grant results, once per session (sessionStorage key 'subscribe-shown').
- **Progress bar** on search runs to 99% on a timer, completes when results land.
- **GDPR banner** uses localStorage key 'gdpr-accepted'.
- Site claims "details never stored or shared" — searches are NOT logged. Keep it that way.

## Known issues / tech debt (priority order)

1. **Grant data architecture** — grants are AI-generated per search (slow ~15-20s, costs money per search, hallucination risk). Planned fix: verified grant database (Supabase) where AI matches rather than generates. THIS IS THE BIG ONE.
2. **sw.js cache version** — named 'theos-fight-v1', never bumped. Users see stale pages after deploys. Increment the cache name on every deploy that changes cached files.
3. **Code duplication** — nav/footer/CSS copy-pasted across every HTML page.
4. **No error monitoring** — consider free Sentry tier.
5. **No search result caching** — common searches (e.g. CP + wheelchair + Liverpool) could be cached to cut API costs.

## CURRENT FOCUS: V3 redesign

A full visual redesign of index.html, approved via mockup (`theosfight-mockup3.html` — Andy has this file). Spec:

- **Aesthetic:** dark cinematic (inspired by daylightcomputer.com and noordinaryaccessories.com)
- **Colours:** --ink #080c10, --navy #0a1628, --blue #2a9fd6, --cream #f5f1eb
- **Fonts:** Cormorant Garamond (serif headlines) + DM Sans (body)
- **Loader:** letter-by-letter "Theo's Fight" reveal, blue "Fight", line drop, clip-path exit
- **Hero:** full-bleed photo of Theo & Aaron (Team BRIT) at Oulton Park — adaptive steering controls, over-the-shoulder shot. Caption: "Theo & Aaron, Team BRIT". EXIF rotation must be handled.
- **Marquee:** equipment types scrolling strip
- **Empathy section:** original quote from Laura & Andy, then editorial no-box pillars (icon | italic faded "reality" | vertical blue divider | bold navy "what we do"). NO boxes, NO strikethrough.
- **Form:** placed LOWER on the page (after empathy + steps) — "let people understand why we're helping before asking for vulnerable details". ALL original fields must remain: name, age, diagnosis, child description textarea, location, equipment checkboxes, additional context textarea.
- **Animated grant preview:** demo Family Fund 92% match appears as form fields are filled
- **Stats:** 381+ families / 35 searches / 11 letters / £0 cost
- **Scroll reveals** on all sections (IntersectionObserver)
- All existing functionality (search, draft, report, subscribe modal, GA4 events, PWA) must keep working.

## NON-NEGOTIABLE content & style rules

1. **NEVER rewrite Andy's text.** The site copy is his and Laura's voice. Layout/design changes are fine; wording changes require explicit approval. When drafting new copy, present it for approval and expect edits in CAPS.
2. **Language:** always "children with additional needs" — never "disabled children" in new copy (some legacy meta tags still use old phrasing).
3. **No assumptions about any child's abilities** — every child is different; copy must never presume what a child can/cannot do.
4. **No unendorsed social proof** — never add charity logos, testimonials or "recommended by" claims that haven't actually happened. Newlife Foundation nursing team genuinely recommends the tool — that one is real and usable.
5. **No paid placements ever** — grants appear on merit only. Affiliate links (future "things we use" page) must be honestly labelled.
6. **Privacy promise is sacred** — family search details are never stored or shared.

## NON-NEGOTIABLE coding rules

1. **Only modify files, functions, and lines of code directly and specifically related to the current task.**
2. **Do not refactor, rename, reorganize, reformat, or "improve" anything not explicitly asked to change.**
3. **If something else worth fixing is noticed, mention it as a note. Do not touch it. Ever.**

## Destructive actions — STOP and confirm first

Before deleting any file, overwriting existing code, dropping database records, removing dependencies, or making any change that cannot be trivially undone — **stop completely**. List exactly what will be affected. Ask for explicit confirmation. Only proceed after Andy says yes in the current message.

The following actions require explicit in-session confirmation before executing, no exceptions:
- Deploying or pushing to any environment (staging, production, etc.)
- Running migrations or schema changes on any database
- Sending any email, message, or external API call
- Executing any command with irreversible external side effects

**"You mentioned this earlier" is not confirmation. Andy must say yes in the current message.**

## Tech stack — always use these, never suggest alternatives unless asked

- **Language:** JavaScript (Node.js backend, vanilla HTML/CSS/JS frontend)
- **Framework:** Express.js
- **Package manager:** npm
- **Database:** none currently (Supabase planned — not yet implemented)
- **Hosting:** Vercel
- **Testing:** none currently
- **Linting/formatting:** none currently

If something in the stack seems like the wrong tool, flag it — but use it anyway unless Andy says otherwise.

## After every coding task — end with this status update

Files changed: [list every file touched]
What was modified: [one line per file]
Files intentionally not touched: [if relevant]
Follow-up needed: [anything requiring attention or a decision]

Keep it short. This is a status update, not a recap.

## General principles

1. **Ask, don't assume.** If something is unclear or underspecified, ask before writing a single line. Never make silent assumptions about intent, architecture, or requirements.
2. **Simplest solution first.** Always implement the simplest thing that could work. Do not add abstractions, layers, or flexibility that weren't explicitly requested.
3. **Don't touch unrelated code.** If a file or function is not directly part of the current task, do not modify it — even if it could be improved.
4. **Flag uncertainty explicitly.** If not confident about an approach, a library's behaviour, or a technical detail, say so before proceeding. Confidence without certainty causes more damage than admitting a gap.

## Working with Andy

- Beginner coder, learning fast. Prefers **step-by-step instructions** — one step, confirm, next step.
- Casual, direct, dry humour. Doesn't want padding or flattery. Wants honest pushback ("the 6 and the 9").
- Pushes back on anything that feels "business not family" — warmth beats conversion optimisation.
- Workflow: edits in VS Code, commits + pushes to GitHub, Vercel auto-deploys. Browser caching has burned us repeatedly — always suggest Ctrl+Shift+R / incognito when testing changes.

## Roadmap (June 2026)

**Now:** V3 redesign build, Wirral Globe press email (Craig Manning, with race car photo), Anthropic outreach post, charity backlink chasing (Newlife, Halton Carers, Claire House).
**Summer:** Supabase verified grant database + testimonials admin, charity grant submission form, condition-specific landing pages, more blog articles.
**Autumn:** Charity CIO registration → Google Ad Grants (£8k/month free ads) + Gift Aid, affiliate kit-list page, grant refresh admin system.

**Separate but related:** Theo's JustGiving fundraiser for Stick 'n' Step — Oulton Park 10k Wheelchair Run, 1 November 2026 (justgiving.com/page/theo-hut-18).

## Mission reminder

Every technical decision serves one purpose: helping exhausted families of children with additional needs find equipment funding without the fight. Speed, trust and warmth are the product. 💙
