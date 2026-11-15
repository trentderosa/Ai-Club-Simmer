/** Line icons from the Direction A mockups (24x24, 1.7 stroke). */
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { color as palette } from '../theme/tokens';

export type IconName =
  | 'back' | 'x' | 'play' | 'pause' | 'check' | 'arrow' | 'alert' | 'pot' | 'list'
  | 'minus' | 'plus' | 'trophy' | 'repeat' | 'timer' | 'lock' | 'reset'
  | 'path' | 'book' | 'user' | 'search';

const shapes: Record<IconName, React.ReactNode> = {
  back: <Path d="M15 5l-7 7 7 7" />,
  x: <Path d="M6 6l12 12M18 6L6 18" />,
  play: <Path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />,
  pause: <Path d="M8 5v14M16 5v14" strokeWidth={3} />,
  check: <Path d="M5 12.5l4.5 4.5L19 7.5" />,
  arrow: <Path d="M4.5 12h15M13.5 6l6 6-6 6" />,
  alert: (
    <>
      <Path d="M12 3.5l9 16H3z" />
      <Path d="M12 10v4.5M12 17.2v.1" />
    </>
  ),
  pot: <Path d="M4 10.5h16v5.5a4 4 0 01-4 4H8a4 4 0 01-4-4zM2.5 10.5h19M9 7.5V6M12 7.5V5M15 7.5V6" />,
  list: (
    <>
      <Path d="M9 6.5h11M9 12h11M9 17.5h11" />
      <Circle cx={4.75} cy={6.5} r={0.9} fill="currentColor" />
      <Circle cx={4.75} cy={12} r={0.9} fill="currentColor" />
      <Circle cx={4.75} cy={17.5} r={0.9} fill="currentColor" />
    </>
  ),
  minus: <Path d="M6 12h12" />,
  plus: <Path d="M12 6v12M6 12h12" />,
  trophy: <Path d="M7.5 4h9v5a4.5 4.5 0 01-9 0zM7.5 6H4.5a3 3 0 003 4M16.5 6h3a3 3 0 01-3 4M12 13.5V17M8.5 20.5h7M9.5 17h5v3.5h-5z" />,
  repeat: <Path d="M4.5 11V9.5a3 3 0 013-3h11M15.5 3.5l3 3-3 3M19.5 13v1.5a3 3 0 01-3 3h-11M8.5 20.5l-3-3 3-3" />,
  timer: (
    <>
      <Circle cx={12} cy={13.5} r={7.5} />
      <Path d="M12 13.5V9.5M9.5 2.5h5M18.5 6.5l1.5-1.5" />
    </>
  ),
  lock: (
    <>
      <Rect x={5.5} y={10.5} width={13} height={9.5} rx={1.5} />
      <Path d="M8.5 10.5V7.5a3.5 3.5 0 017 0v3" />
    </>
  ),
  reset: <Path d="M4.5 12a7.5 7.5 0 102.2-5.3M4.5 4.5v4h4" />,
  path: (
    <>
      <Circle cx={6.5} cy={5.5} r={2.5} />
      <Circle cx={17.5} cy={12} r={2.5} />
      <Circle cx={6.5} cy={18.5} r={2.5} />
      <Path d="M8.8 6.6l6.4 4.1M15.2 13.3l-6.4 4.1" />
    </>
  ),
  book: <Path d="M4 4.5h6a2 2 0 012 2V20a1.5 1.5 0 00-1.5-1.5H4zM20 4.5h-6a2 2 0 00-2 2V20a1.5 1.5 0 011.5-1.5H20z" />,
  user: (
    <>
      <Circle cx={12} cy={8} r={4} />
      <Path d="M4.5 20.5c1-4 4-6 7.5-6s6.5 2 7.5 6" />
    </>
  ),
  search: (
    <>
      <Circle cx={10.5} cy={10.5} r={6} />
      <Path d="M15 15l5 5" />
    </>
  ),
};

export function Icon({ name, size = 22, color = palette.ink, strokeWidth = 1.7 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      color={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {shapes[name]}
    </Svg>
  );
}
