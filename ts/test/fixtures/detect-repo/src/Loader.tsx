import dynamic from "next/dynamic";
const LazyWidget = dynamic(() => import("./Widget"));
export { LazyWidget };
