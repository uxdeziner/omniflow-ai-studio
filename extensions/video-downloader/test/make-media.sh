#!/usr/bin/env bash
# Generates the synthetic test clips (a 12 s test pattern with a tone) in every delivery format
# the extension handles. Needs ffmpeg and openssl. Output: test/media/ (git-ignored).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p media && cd media
mkdir -p hls-ts hls-fmp4 hls-aes dash dash-low dash-single split
ff() { ffmpeg -y -v error "$@"; }

ff -f lavfi -i "testsrc2=size=640x360:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 12 \
  -c:v libx264 -preset veryfast -g 60 -keyint_min 60 -sc_threshold 0 -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart progressive.mp4

# HLS with MPEG-TS segments and a two-quality master playlist
ff -i progressive.mp4 -c copy -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_filename 'hls-ts/seg%03d.ts' hls-ts/media.m3u8
cp hls-ts/media.m3u8 hls-ts/low.m3u8
printf '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"\nmedia.m3u8\n' > hls-ts/master.m3u8

# HLS with fMP4 segments and a separate audio rendition
ff -i progressive.mp4 -an -c:v copy -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 -hls_fmp4_init_filename vinit.mp4 -hls_segment_filename 'hls-fmp4/v%03d.m4s' hls-fmp4/video.m3u8
ff -i progressive.mp4 -vn -c:a copy -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 -hls_fmp4_init_filename ainit.mp4 -hls_segment_filename 'hls-fmp4/a%03d.m4s' hls-fmp4/audio.m3u8
printf '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,AUDIO="aud"\nvideo.m3u8\n' > hls-fmp4/master.m3u8

# HLS with AES-128 encrypted segments
openssl rand 16 > hls-aes/key.bin
printf 'key.bin\nhls-aes/key.bin\n%s\n' "$(openssl rand -hex 16)" > keyinfo.txt
ff -i progressive.mp4 -c copy -f hls -hls_time 2 -hls_playlist_type vod -hls_key_info_file keyinfo.txt -hls_segment_filename 'hls-aes/seg%03d.ts' hls-aes/media.m3u8
rm keyinfo.txt

# DASH with a segment template (and a low-quality rendition for the quality-switch test)
ff -i progressive.mp4 -c copy -map 0:v -map 0:a -f dash -seg_duration 2 -use_template 1 -use_timeline 1 -adaptation_sets "id=0,streams=v id=1,streams=a" dash/manifest.mpd
ff -i progressive.mp4 -an -vf scale=320:180 -c:v libx264 -preset veryfast -g 60 -keyint_min 60 -sc_threshold 0 -f dash -seg_duration 2 -use_template 1 -use_timeline 1 dash-low/manifest.mpd

# Separate video-only and audio-only files
ff -i progressive.mp4 -an -c:v copy -movflags +frag_keyframe+empty_moov+default_base_moof split/video.mp4
ff -i progressive.mp4 -vn -c:a copy -movflags +frag_keyframe+empty_moov+default_base_moof -frag_duration 2000000 split/audio.mp4

# DASH whose tracks are single files
cp split/video.mp4 dash-single/DASH_360.mp4
cp split/audio.mp4 dash-single/DASH_AUDIO_128.mp4
cat > dash-single/DASHPlaylist.mpd <<'XML'
<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S">
 <Period>
  <AdaptationSet contentType="video" mimeType="video/mp4">
   <Representation id="v360" bandwidth="800000" width="640" height="360" codecs="avc1.64001e"><BaseURL>DASH_360.mp4</BaseURL><SegmentBase indexRange="0-100"><Initialization range="0-50"/></SegmentBase></Representation>
  </AdaptationSet>
  <AdaptationSet contentType="audio" mimeType="audio/mp4">
   <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2"><BaseURL>DASH_AUDIO_128.mp4</BaseURL></Representation>
  </AdaptationSet>
 </Period>
</MPD>
XML
echo "Test media ready in $(pwd)"
