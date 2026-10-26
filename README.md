# 한국 고전 원문·번역 통합 탐색 허브

한국학중앙연구원, 승정원일기, 한국고전번역원 등 여러 기관의 한문 고전 원문·한글 번역 공개 데이터를
한 곳에서 검색·탐색할 수 있는 정적 페이지입니다. 각 기관 데이터는 각자의 저장소에서 그대로 관리하고,
이 페이지는 `sources.json`에 등록된 색인만 모아 보여줍니다.

- https://seoul-raphael.github.io/korean-classics-hub/

이 페이지가 기본 진입점입니다. 기존 `aks-yoksa-mimo-proposal` 저장소의 첫 페이지도
이제 이 통합 허브를 우선 링크로 안내합니다(데이터 자체는 계속 그 저장소에서 관리·공개).

## 구조

- `sources.json`: 소스별 이름·데이터 위치·필드 매핑. 새 기관을 추가하려면 여기에 항목 하나만 더하면 됩니다
  (해당 저장소가 flat JSONL 색인 파일을 공개하고 있어야 합니다).
- `index.html` / `app.js` / `styles.css`: 검색·정렬·소스 탭 UI와 페이지 안 리더. 항목을 누르면 원 저장소의
  Markdown 을 가져와 이 페이지 안에서 보여줍니다(`#src=…&id=…`). 목록 상태는 `?q=…&src=…&sort=…` 로 주소에 남습니다.

### `sources.json` 항목 필드

| 필드 | 뜻 |
|---|---|
| `id`, `name`, `description` | 출처 식별자·표시 이름·설명 |
| `base_url`, `index_path` | 데이터 저장소 주소와 JSONL 색인 경로 |
| `status` | `active`(검색 가능) 또는 `in_progress`(탭에 "준비 중"으로만 표시) |
| `reader` | `book`(책 소개·해제·묶음 N, `parts_index_path` 필요) 또는 `article`(한 쪽, 날짜 순 이전/다음) |
| `stats_path`, `stats_key` | 진행 통계 JSON 과 그 안의 키(기사 수 표시용, 선택) |
| `item_unit` | 탭 개수 단위(예: `권`, `일`, 선택) |
| `date_sort_mode` | `year`(값에서 네 자리 연도를 뽑아 정렬) 또는 `text`(값 그대로 정렬) |
| `fields.id` … `fields.path` | 색인 행의 열 이름을 공통 필드(제목·한자 제목·저자·날짜·기사 수·경로)로 연결 |
| `fields.title_sort`, `fields.date_sort` | 제목순·날짜순 정렬에 쓸 열(선택, 예: 승정원일기 `day_key`) |

## 현재 연결된 소스

| 소스 | 저장소 | 상태 |
|---|---|---|
| 한국학중앙연구원 | [aks-yoksa-mimo-proposal](https://github.com/SEOUL-raphael/aks-yoksa-mimo-proposal) | 공개, 검색 가능 |
| 승정원일기 | (비공개 파이프라인, 성공 번역분만 위 저장소에 함께 공개) | 공개, 검색 가능 |
| 한국고전번역원 | (비공개 파이프라인) | 번역 진행 중 |

## 향후 확장 후보

고려대 민족문화연구원 관련 링크 목록(<https://kuclt.korea.ac.kr/kuclt/etc/link.do>)에 있는 기관들을
순차적으로 검토해 추가할 예정입니다: 규장각한국학연구원, 한국고전종합DB, 조선왕조실록, 승정원일기,
한국역사정보통합시스템 등.
