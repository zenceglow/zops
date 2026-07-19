import { AuthPrefs } from '../../components/auth-prefs';
import { SetupForm } from './_components/setup-form';

export default function SetupPage() {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-gradient-to-br from-zinc-50 via-background to-amber-50/40 dark:from-zinc-950 dark:via-background dark:to-amber-950/20" />
        <div className="absolute left-[-8rem] top-[-8rem] size-[26rem] rounded-full bg-gradient-to-br from-amber-400/25 to-orange-300/10 blur-3xl" />
        <div className="absolute bottom-[-6rem] right-[-8rem] size-[28rem] rounded-full bg-gradient-to-br from-sky-400/15 to-zinc-300/10 blur-3xl dark:from-sky-500/10" />
      </div>

      <header className="absolute right-3 top-3 z-10 sm:right-5 sm:top-5">
        <AuthPrefs />
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <SetupForm />
      </main>
    </div>
  );
}
