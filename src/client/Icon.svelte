<script lang="ts">
 const paths={
  sidebar:'M3 4h18v16H3z M9 4v16 M5.5 8h1 M5.5 12h1',
  graph:'M3 4h6v5H3z M15 15h6v5h-6z M9 6.5h7v8.5 M5 9v8.5h10',
  timeline:'M4 5v15 M4 8h8 M12 5v6 M12 11h7 M19 8v6 M4 17h15',
  list:'M8 6h13 M8 12h13 M8 18h13 M3 6h1 M3 12h1 M3 18h1',
  search:'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5',
  filters:'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  plus:'M12 5v14 M5 12h14',
  undo:'M9 5 4 10l5 5 M4 10h10a6 6 0 0 1 6 6v3',
  redo:'m15 5 5 5-5 5 M20 10H10a6 6 0 0 0-6 6v3',
  more:'M5 12h.01 M12 12h.01 M19 12h.01',
  import:'M12 3v12 M7 10l5 5 5-5 M4 15v6h16v-6',
  export:'M12 15V3 M7 8l5-5 5 5 M4 15v6h16v-6',
  settings:'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  refresh:'M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 14 6 M18 18A8 8 0 0 1 4 12',
  sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5 19 19 M5 19l1.5-1.5 M17.5 6.5 19 5',
  moon:'M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5',
  close:'m6 6 12 12 M6 18 18 6',
  arrow:'M5 19 19 5 M7 5h12v12',
  shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
  chevron:'m8 5 7 7-7 7',
  book:'M4 4h7v16H4z M13 4h7v16h-7z M11 4v16',
  agent:'M5 8h14v9H5z M9 11h.01 M15 11h.01 M9 14h6 M12 4v4 M8 20l-1-3 M16 20l1-3',
  edit:'M4 20h4L20 8l-4-4L4 16z M14 6l4 4',
  save:'M5 4h11l3 3v13H5z M8 4v6h7V4 M8 20v-6h8v6',
  image:'M3 5h18v14H3z M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3 M4 17l5-5 4 4 3-3 4 4'
 };
 let {name,size=16}:{name:keyof typeof paths;size?:number}=$props();
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={name==='more'?3:1.6} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]}/></svg>
