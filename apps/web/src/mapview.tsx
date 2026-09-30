import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Candidate, Origin } from '../../../packages/contracts/index';
// Loaded on demand: Leaflet is only fetched when someone opens the map view.
const hh = (t: number | string) => new Date(t).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
// Results on an OpenStreetMap: numbered pins in ranking order and the start point.
export default function ResultsMap({ results, origin, onOpen }: { results: Candidate[]; origin?: Origin; onOpen: (c: Candidate) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const map = L.map(ref.current, { scrollWheelZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© участники OpenStreetMap' }).addTo(map);
    const points: L.LatLngExpression[] = [];
    if (origin) { points.push([origin.lat, origin.lon]); L.marker([origin.lat, origin.lon], { icon: L.divIcon({ className: 'map-start', html: '<span>Ты</span>', iconSize: [38, 38] }), keyboard: false }).addTo(map); }
    results.forEach((c, i) => {
      points.push([c.event.latitude, c.event.longitude]);
      L.marker([c.event.latitude, c.event.longitude], { icon: L.divIcon({ className: 'map-pin', html: `<span>${i + 1}</span>`, iconSize: [32, 32] }), title: c.event.title }).bindTooltip(`${i + 1}. ${c.event.title} · ${hh(c.startAt)}`).on('click', () => onOpen(c)).addTo(map);
    });
    if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 15 });
    return () => { map.remove(); };
  }, [results, origin?.lat, origin?.lon]);
  return <div ref={ref} className="results-map" aria-label="Карта вариантов"/>;
}
