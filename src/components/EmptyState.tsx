export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <section className="emptyState">
      <h2>{title}</h2>
      <p>{body}</p>
    </section>
  );
}

