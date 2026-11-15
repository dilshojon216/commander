import Link from "next/link";

export default function NotFound() {
  return (
    <div className="px-4 py-16 text-center">
      <h1 className="m-0 text-lg font-semibold">Topilmadi</h1>
      <p className="mt-1 text-mu">Bunday sahifa mavjud emas yoki ruxsat etilmagan.</p>
      <Link href="/" className="btn btn-pri mt-3">
        Bosh sahifaga qaytish
      </Link>
    </div>
  );
}
