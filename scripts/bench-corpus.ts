// Shared labeled corpus for the retrieval benchmarks. Confusable clusters (several neurons share a
// topic; each query must pick the ONE right neuron out of its near-siblings). Queries are hard
// paraphrases — low literal-token overlap — so they measure meaning, not keyword overlap.
//   pg* Postgres perf · au* auth · rx* React render · as* async/net · ds* distributed · mx* misc
export interface Doc { id: string; text: string; answer: string; }
export interface Query { q: string; target: string; }

export const DOCS: Doc[] = [
  { id: "pg1", text: "How do you make a Postgres query doing a sequential scan faster?", answer: "Add an index on the filtered column so the planner uses an index scan instead of reading every row." },
  { id: "pg2", text: "How do you fix an N+1 query problem with an ORM?", answer: "Eager-load the related rows in one join/batch query instead of issuing a query per parent row." },
  { id: "pg3", text: "Why is my Postgres table getting slower and bloated over time?", answer: "Dead tuples accumulate from updates/deletes; run VACUUM (or autovacuum) to reclaim space and refresh stats." },
  { id: "pg4", text: "Why does my service run out of Postgres connections under load?", answer: "Each request opens its own connection; put a pooler like PgBouncer in front to cap and reuse connections." },

  { id: "au1", text: "What is the difference between authentication and authorization?", answer: "Authentication verifies who you are; authorization decides what you are allowed to do once identified." },
  { id: "au2", text: "How do you store user passwords securely?", answer: "Hash with a slow salted algorithm like bcrypt or Argon2; never store plaintext or fast unsalted hashes." },
  { id: "au3", text: "How do you handle expiring JWT access tokens?", answer: "Issue a short-lived access token plus a long-lived refresh token, and rotate the refresh token on use." },

  { id: "rx1", text: "Why does my React component render twice in development?", answer: "React 18 StrictMode intentionally double-invokes render and effects in dev to surface impure logic." },
  { id: "rx2", text: "Why does my useEffect run in an infinite loop?", answer: "An effect updates state that is also in its dependency array; remove the dep or memoize the value." },
  { id: "rx3", text: "Why does my React list re-render or reorder incorrectly?", answer: "Use a stable unique key per item instead of the array index so reconciliation tracks elements correctly." },

  { id: "as1", text: "How do you cancel an in-flight HTTP request in the browser?", answer: "Use an AbortController: pass its signal into fetch and call abort() to cancel the request." },
  { id: "as2", text: "How do you debounce a function in JavaScript?", answer: "Clear a pending timer on each call and set a new one, so it only runs after activity pauses." },
  { id: "as3", text: "How do you handle retries for a flaky network call?", answer: "Retry with exponential backoff and jitter, a capped attempt count, only for idempotent operations." },

  { id: "ds1", text: "What does eventual consistency mean in a distributed system?", answer: "Replicas may briefly disagree but converge to the same value once writes stop propagating." },
  { id: "ds2", text: "How do you stop duplicate processing when a client retries a request?", answer: "Require an idempotency key so the server records and de-duplicates repeated requests." },
  { id: "ds3", text: "What causes a deadlock between two database transactions?", answer: "Each holds a lock the other needs and both wait forever; a consistent lock ordering avoids it." },

  { id: "mx1", text: "Why is my Docker image so large?", answer: "Layers retain build artifacts; use a multi-stage build and a slim base image to shrink the final size." },
  { id: "mx2", text: "How do you fix a memory leak in a long-running Node process?", answer: "Take heap snapshots, find retained objects such as unbounded caches or stray listeners, and release them." },
  { id: "mx3", text: "How do you center a div with CSS?", answer: "Use flexbox on the parent: display:flex with justify-content:center and align-items:center." },
  { id: "mx4", text: "Why is the browser blocking my API call with a CORS error?", answer: "The server must send Access-Control-Allow-Origin (and preflight) headers permitting your origin." },
];

export const QUERIES: Query[] = [
  { q: "the planner keeps reading the whole table instead of using an index", target: "pg1" },
  { q: "speed up a slow SELECT that filters on one column", target: "pg1" },
  { q: "my ORM fires one extra query for every row in a loop", target: "pg2" },
  { q: "the table keeps growing and queries degrade after lots of updates", target: "pg3" },
  { q: "we keep exhausting available database connections when traffic spikes", target: "pg4" },

  { q: "difference between proving who you are and granting permissions", target: "au1" },
  { q: "the right way to keep account credentials safe at rest", target: "au2" },
  { q: "what to do when the bearer token a client holds expires", target: "au3" },

  { q: "my component runs its render function twice while developing", target: "rx1" },
  { q: "the effect hook keeps firing over and over without stopping", target: "rx2" },
  { q: "rows jump around when I add items because I used the position as the identifier", target: "rx3" },

  { q: "stop a fetch that is already running", target: "as1" },
  { q: "only fire a handler after the user stops typing", target: "as2" },
  { q: "automatically re-attempt a request that intermittently fails", target: "as3" },

  { q: "replicas temporarily out of sync but agree later", target: "ds1" },
  { q: "avoid processing the same submission twice when the client resends it", target: "ds2" },
  { q: "two transactions stuck waiting on each other forever", target: "ds3" },

  { q: "shrink the size of my built container image", target: "mx1" },
  { q: "node service memory keeps creeping up over days of uptime", target: "mx2" },
  { q: "vertically and horizontally align a box in the middle of the page", target: "mx3" },
  { q: "the browser refuses my cross-origin request from the frontend", target: "mx4" },
];
