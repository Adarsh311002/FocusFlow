import { Critter, ToucanArt } from '../../ui/jungle/critters';
import { CreateRoomForm } from './create-room-form';
import { JoinByCode } from './join-by-code';
import { RoomList } from './room-list';

const CARD = 'rounded-[2rem] border border-line bg-surface p-6 shadow-card backdrop-blur-xl md:p-8';

/** `/rooms`: the user's rooms, creating one, and joining one by its code. */
export function RoomsPage() {
  return (
    <section aria-labelledby="rooms-heading" className="relative space-y-10">
      <Critter kind="toucan" className="-top-4 right-[36%] hidden lg:block" bubble="left">
        <ToucanArt flip />
      </Critter>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="text-xs tracking-[0.3em] text-focus uppercase">( Body doubling )</p>
          <h2 id="rooms-heading" className="font-display mt-3 text-6xl md:text-7xl">
            Rooms
          </h2>
        </div>
        <p className="font-display max-w-sm text-2xl text-muted">
          Focus is easier <em className="text-focus">side by side.</em>
        </p>
      </div>
      <RoomList />
      <div className="grid items-start gap-6 md:grid-cols-2">
        <div className={CARD}>
          <CreateRoomForm />
        </div>
        <div className={CARD}>
          <JoinByCode />
        </div>
      </div>
    </section>
  );
}
