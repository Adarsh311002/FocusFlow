import { CreateRoomForm } from './create-room-form';
import { JoinByCode } from './join-by-code';
import { RoomList } from './room-list';

/** `/rooms`: the user's rooms, creating one, and joining one by its code. */
export function RoomsPage() {
  return (
    <section aria-labelledby="rooms-heading" className="max-w-xl space-y-8">
      <h2 id="rooms-heading" className="text-base font-semibold">
        Rooms
      </h2>
      <RoomList />
      <CreateRoomForm />
      <JoinByCode />
    </section>
  );
}
