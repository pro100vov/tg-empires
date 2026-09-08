import { useEffect } from 'react';

interface Props {
  message: string;
  onHide: () => void;
}

export default function Toast({ message, onHide }: Props) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onHide, 2600);
    return () => clearTimeout(timer);
  }, [message, onHide]);

  if (!message) return null;
  return <div className="toast">{message}</div>;
}
