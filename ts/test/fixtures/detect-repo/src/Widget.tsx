export function Widget({ onDelete, isLoading, title }: Props) {
  const handleClick = () => {
    onDelete(title);
  };
  const handleHover = () => {
    console.log(title);
  };
  return <div onClick={handleClick} onMouseOver={handleHover}>{isLoading ? "..." : title}</div>;
}
