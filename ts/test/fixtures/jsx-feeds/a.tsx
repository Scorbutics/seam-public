export function Page({ user, orders }) {
  return (
    <div>
      <Widget id={user.id} label="hello" flag onSave={() => save(user)} />
      <Widget id={orders[0].id} label={"dyn" + suffix} />
      <Other id={user.id} />
      <ns.Widget id={user.id} nested={{ a: 1 }} />
    </div>
  );
}
