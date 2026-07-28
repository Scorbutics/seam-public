const El = <Widget
  multi={a}
  spread={...rest}
  empty={}
  str='single'
  tmpl={`t${x}`}
/>;
const Self = <Widget />;
const Nested = <Outer><Widget deep={y} /></Outer>;
