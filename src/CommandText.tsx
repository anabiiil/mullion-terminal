import { tokenizeCommand } from './command-highlight';

export default function CommandText({ value }: { value: string }) {
  return <>{tokenizeCommand(value).map((segment, index) => segment.kind === 'arg'
    ? segment.text
    : <span key={index} className={`cmd-${segment.kind === 'command' ? 'name' : segment.kind}`}>{segment.text}</span>)}</>;
}
