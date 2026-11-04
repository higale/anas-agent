export function IconImage({ data, size, className }: { data: string; size: number; className?: string }) {
  return <img className={className ? `ui-icon-image ${className}` : 'ui-icon-image'} src={data}
    alt="" width={size} height={size} draggable={false} />
}
