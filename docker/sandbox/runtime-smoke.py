import importlib
import importlib.metadata
import json
import os


EXPECTED = {
    "Pillow": ("PIL", "11.3.0"),
    "duckdb": ("duckdb", "1.3.2"),
    "matplotlib": ("matplotlib", "3.10.5"),
    "numpy": ("numpy", "2.3.2"),
    "openpyxl": ("openpyxl", "3.1.5"),
    "pandas": ("pandas", "2.3.2"),
    "pyarrow": ("pyarrow", "21.0.0"),
    "pypdf": ("pypdf", "6.0.0"),
    "python-docx": ("docx", "1.2.0"),
    "python-pptx": ("pptx", "1.0.2"),
    "reportlab": ("reportlab", "4.4.3"),
    "scikit-learn": ("sklearn", "1.7.1"),
    "scipy": ("scipy", "1.16.1"),
    "xlsxwriter": ("xlsxwriter", "3.2.5"),
}


def main() -> None:
    actual = {}
    for distribution, (module, expected_version) in sorted(EXPECTED.items()):
        importlib.import_module(module)
        version = importlib.metadata.version(distribution)
        if version != expected_version:
            raise RuntimeError(
                f"{distribution} version {version} != {expected_version}"
            )
        actual[distribution] = version

    if hasattr(os, "getuid") and os.getuid() == 0:
        raise RuntimeError("runtime smoke must execute as non-root")
    print(json.dumps(actual, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
